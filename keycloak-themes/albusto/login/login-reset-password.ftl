<#import "template.ftl" as layout>
<#--
  Albusto themed "forgot password" entry — Keycloak login-reset-password.ftl.
  Field `username`; posts to url.loginAction; KC emails a reset link.
-->
<@layout.registrationLayout displayInfo=false displayMessage=!messagesPerField.existsError('username'); section>
  <#if section = "header">
    <h1>Reset your password</h1>
    <p class="lede">Enter your email and we&rsquo;ll send you a link to reset it.</p>

  <#elseif section = "form">
    <form id="kc-reset-password-form" action="${url.loginAction}" method="post">
      <div class="field">
        <input id="username" name="username" type="text" autofocus placeholder=" " spellcheck="false"
               value="${(auth.attemptedUsername!'')}" autocomplete="username"
               aria-invalid="<#if messagesPerField.existsError('username')>true</#if>" />
        <label for="username"><#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>Email or username<#else>${msg("email")}</#if></label>
      </div>

      <#if messagesPerField.existsError('username')>
        <span class="field-error" aria-live="polite">${kcSanitize(messagesPerField.getFirstError('username'))?no_esc}</span>
      </#if>

      <button class="btn" type="submit" style="margin-top:8px">Send reset link</button>
      <p class="aux"><a class="link" href="${url.loginUrl}">Back to sign in</a></p>
    </form>
  </#if>
</@layout.registrationLayout>
