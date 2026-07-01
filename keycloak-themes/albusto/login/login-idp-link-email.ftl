<#import "template.ftl" as layout>
<#--
  Albusto themed "we emailed you to link your account" page
  (Keycloak login-idp-link-email.ftl). Shown after the user chose to link a social
  (Google) sign-in to an existing account and Keycloak verifies ownership by email.
  Without an override this fell back to unstyled base markup — GOOGLE-SSO-FIX-001
  follow-up. (Skipped entirely when auto-link is enabled; see setup-google-idp.sh.)

  KC 26 context:
    - idpDisplayName          : the identity provider display name (e.g. "Google")
    - brokerContext.username  : the existing account the link email was sent to
    - url.loginAction         : resend / continue target
-->
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    <h1>Check your email</h1>
    <p class="lede">
      We emailed<#if (brokerContext.username)?has_content> <strong>${kcSanitize(brokerContext.username)?no_esc}</strong></#if>
      a link to connect your ${(idpDisplayName!'Google')} sign-in to your existing Albusto account.
    </p>

  <#elseif section = "form">
    <p class="instruction">Open the link in that email to finish connecting your account &mdash; then you can sign in with ${(idpDisplayName!'Google')}. You can close this tab.</p>
    <#if url.loginAction?has_content>
      <p class="aux">Didn&rsquo;t get it? <a href="${url.loginAction}">Resend the email</a>.</p>
    </#if>
  </#if>
</@layout.registrationLayout>
