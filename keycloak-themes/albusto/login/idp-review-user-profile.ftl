<#import "template.ftl" as layout>
<#--
  Albusto themed "review your profile" for social sign-up — Keycloak
  idp-review-user-profile.ftl. Shown when first-broker-login asks the user to
  confirm the details imported from the IdP (Google). Skipped entirely when the
  auto-link flow is active (idp-review-profile DISABLED — see setup-google-idp.sh);
  this is the themed fallback. Fields email/firstName/lastName post to url.loginAction.
-->
<@layout.registrationLayout displayMessage=!messagesPerField.exists('global'); section>
  <#if section = "header">
    <h1>Confirm your details</h1>
    <p class="lede">Review the information from <#if idpDisplayName??>${idpDisplayName}<#else>your provider</#if> before continuing.</p>

  <#elseif section = "form">
    <form id="kc-idp-review-profile-form" action="${url.loginAction}" method="post">
      <#if !realm.registrationEmailAsUsername>
        <div class="field">
          <input id="username" name="username" type="text" placeholder=" " autocomplete="username"
                 value="${(user.username!'')}" />
          <label for="username">Username</label>
        </div>
      </#if>
      <div class="field">
        <input id="email" name="email" type="email" placeholder=" " autocomplete="email" value="${(user.email!'')}" />
        <label for="email">Email</label>
      </div>
      <div class="field">
        <input id="firstName" name="firstName" type="text" placeholder=" " autocomplete="given-name" value="${(user.firstName!'')}" />
        <label for="firstName">First name</label>
      </div>
      <div class="field">
        <input id="lastName" name="lastName" type="text" placeholder=" " autocomplete="family-name" value="${(user.lastName!'')}" />
        <label for="lastName">Last name</label>
      </div>

      <button class="btn" type="submit" style="margin-top:8px">Continue</button>
    </form>
  </#if>
</@layout.registrationLayout>
