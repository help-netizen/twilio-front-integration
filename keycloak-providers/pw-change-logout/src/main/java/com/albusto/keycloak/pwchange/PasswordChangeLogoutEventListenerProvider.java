package com.albusto.keycloak.pwchange;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import jakarta.ws.rs.core.HttpHeaders;
import jakarta.ws.rs.core.UriInfo;

import org.jboss.logging.Logger;
import org.keycloak.common.ClientConnection;
import org.keycloak.events.Details;
import org.keycloak.events.Event;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventType;
import org.keycloak.events.admin.AdminEvent;
import org.keycloak.events.admin.OperationType;
import org.keycloak.models.KeycloakContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserSessionModel;
import org.keycloak.models.UserSessionProvider;
import org.keycloak.models.credential.PasswordCredentialModel;
import org.keycloak.services.managers.AuthenticationManager;

public final class PasswordChangeLogoutEventListenerProvider implements EventListenerProvider {
    private static final Logger LOG = Logger.getLogger(PasswordChangeLogoutEventListenerProvider.class);

    private final KeycloakSession session;

    public PasswordChangeLogoutEventListenerProvider(KeycloakSession session) {
        this.session = session;
    }

    @Override
    public void onEvent(Event event) {
        try {
            if (!isPasswordChange(event)) {
                return;
            }

            revokeSessions(event.getRealmId(), event.getUserId(), event.getSessionId());
        } catch (Exception e) {
            LOG.error("Failed to revoke other sessions after a user password change", e);
        }
    }

    @Override
    public void onEvent(AdminEvent event, boolean includeRepresentation) {
        try {
            String userId = adminPasswordResetUserId(event);
            if (userId == null) {
                return;
            }

            revokeSessions(event.getRealmId(), userId, null);
        } catch (Exception e) {
            LOG.error("Failed to revoke sessions after an administrator password reset", e);
        }
    }

    private boolean isPasswordChange(Event event) {
        if (event == null || event.getType() == null) {
            return false;
        }

        if (event.getType() == EventType.UPDATE_PASSWORD) {
            return true;
        }

        if (event.getType() != EventType.UPDATE_CREDENTIAL) {
            return false;
        }

        Map<String, String> details = event.getDetails();
        return details != null
                && PasswordCredentialModel.TYPE.equals(details.get(Details.CREDENTIAL_TYPE));
    }

    private String adminPasswordResetUserId(AdminEvent event) {
        if (event == null || event.getError() != null || event.getRealmId() == null) {
            return null;
        }

        OperationType operation = event.getOperationType();
        if (operation != OperationType.ACTION && operation != OperationType.UPDATE) {
            return null;
        }

        String resourcePath = event.getResourcePath();
        if (resourcePath == null || resourcePath.isBlank()) {
            return null;
        }

        String[] segments = resourcePath.split("/");
        for (int i = 0; i + 2 < segments.length; i++) {
            if ("users".equals(segments[i])
                    && !segments[i + 1].isBlank()
                    && "reset-password".equals(segments[i + 2])) {
                return segments[i + 1];
            }
        }

        return null;
    }

    private void revokeSessions(String realmId, String userId, String currentSessionId) {
        if (realmId == null || userId == null) {
            LOG.warn("Password-change event did not contain a realm or user id");
            return;
        }

        RealmModel realm = session.realms().getRealm(realmId);
        if (realm == null) {
            LOG.warnf("Realm %s was not found while revoking password-change sessions", realmId);
            return;
        }

        UserModel user = session.users().getUserById(realm, userId);
        if (user == null) {
            LOG.warnf("User %s was not found while revoking password-change sessions", userId);
            return;
        }

        UserSessionProvider sessions = session.sessions();
        revokeOnlineSessions(sessions, realm, user, currentSessionId);
        revokeOfflineSessions(sessions, realm, user);
    }

    private void revokeOnlineSessions(
            UserSessionProvider sessions,
            RealmModel realm,
            UserModel user,
            String currentSessionId) {
        try {
            List<UserSessionModel> sessionsToRemove = sessions.getUserSessionsStream(realm, user)
                    .filter(userSession -> !Objects.equals(userSession.getId(), currentSessionId))
                    .collect(Collectors.toList());

            for (UserSessionModel userSession : sessionsToRemove) {
                try {
                    logoutSession(realm, userSession);
                } catch (Exception e) {
                    LOG.errorf(e, "Failed to revoke online session %s for user %s",
                            userSession.getId(), user.getId());
                }
            }
        } catch (Exception e) {
            LOG.errorf(e, "Failed to enumerate online sessions for user %s", user.getId());
        }
    }

    /**
     * Terminates one online session AND notifies every client that registered an OIDC
     * Back-Channel Logout URL (a signed logout_token POST), so a protected resource can
     * revoke a still-valid access token on its very next request instead of waiting for the
     * token to expire. AuthenticationManager.backchannelLogout performs BOTH the client
     * notification and the session removal, so callers must not also call removeUserSession.
     *
     * The emitted logout token is session-specific (carries `sid`), so only the sessions
     * enumerated by the caller — every session except the one that just changed the
     * password — are torn down; the current session survives.
     *
     * If the active request context lacks the URI/connection/headers backchannelLogout
     * needs to mint the token, fall back to a silent removal so a password change can never
     * fail: the session is still invalidated, just without the instant notification (it
     * lapses when its access token expires).
     */
    private void logoutSession(RealmModel realm, UserSessionModel userSession) {
        KeycloakContext context = session.getContext();
        UriInfo uriInfo = context != null ? context.getUri() : null;
        ClientConnection connection = context != null ? context.getConnection() : null;
        HttpHeaders headers = context != null ? context.getRequestHeaders() : null;

        if (uriInfo == null || connection == null || headers == null) {
            LOG.warnf("No request context while revoking session %s; removing it without a "
                    + "back-channel logout notification", userSession.getId());
            session.sessions().removeUserSession(realm, userSession);
            return;
        }

        // logoutBroker=true also propagates the logout to linked identity providers
        // (e.g. Google SSO), matching a full password-change security posture.
        AuthenticationManager.backchannelLogout(session, realm, userSession, uriInfo, connection,
                headers, true);
    }

    private void revokeOfflineSessions(UserSessionProvider sessions, RealmModel realm, UserModel user) {
        try {
            List<UserSessionModel> sessionsToRemove = sessions.getOfflineUserSessionsStream(realm, user)
                    .collect(Collectors.toList());

            for (UserSessionModel userSession : sessionsToRemove) {
                try {
                    sessions.removeOfflineUserSession(realm, userSession);
                } catch (Exception e) {
                    LOG.errorf(e, "Failed to revoke offline session %s for user %s",
                            userSession.getId(), user.getId());
                }
            }
        } catch (Exception e) {
            LOG.errorf(e, "Failed to enumerate offline sessions for user %s", user.getId());
        }
    }

    @Override
    public void close() {
        // No resources are owned by this provider instance.
    }
}
