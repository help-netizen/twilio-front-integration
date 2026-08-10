package com.albusto.keycloak.pwchange;

import org.keycloak.Config;
import org.keycloak.events.EventListenerProvider;
import org.keycloak.events.EventListenerProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

public final class PasswordChangeLogoutEventListenerProviderFactory implements EventListenerProviderFactory {
    public static final String PROVIDER_ID = "pw-change-logout";

    @Override
    public EventListenerProvider create(KeycloakSession session) {
        return new PasswordChangeLogoutEventListenerProvider(session);
    }

    @Override
    public void init(Config.Scope config) {
        // No configuration is required.
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {
        // No post-initialization is required.
    }

    @Override
    public void close() {
        // No resources are owned by this factory.
    }

    @Override
    public String getId() {
        return PROVIDER_ID;
    }
}
