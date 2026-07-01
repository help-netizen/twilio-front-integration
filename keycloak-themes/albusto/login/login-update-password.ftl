<#import "template.ftl" as layout>
<#--
  Albusto themed "set a new password" — Keycloak login-update-password.ftl.
  Fields `password-new` + `password-confirm`; posts to url.loginAction.
-->
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>
  <#if section = "header">
    <h1>Set a new password</h1>
    <p class="lede">Choose a password you don&rsquo;t use anywhere else.</p>

  <#elseif section = "form">
    <form id="kc-passwd-update-form" action="${url.loginAction}" method="post">
      <div class="field field__pw">
        <input id="password-new" name="password-new" type="password" autofocus autocomplete="new-password"
               placeholder=" " aria-invalid="<#if messagesPerField.existsError('password','password-confirm')>true</#if>" />
        <label for="password-new">New password</label>
      </div>
      <div class="field field__pw">
        <input id="password-confirm" name="password-confirm" type="password" autocomplete="new-password"
               placeholder=" " aria-invalid="<#if messagesPerField.existsError('password-confirm')>true</#if>" />
        <label for="password-confirm">Confirm password</label>
      </div>

      <#if messagesPerField.existsError('password','password-confirm')>
        <span class="field-error" aria-live="polite">${kcSanitize(messagesPerField.getFirstError('password','password-confirm'))?no_esc}</span>
      </#if>

      <#if isAppInitiatedAction??>
        <div class="row-between" style="margin-top:6px">
          <label class="remember"><input type="checkbox" name="logout-sessions" value="on" checked> Sign out of other devices</label>
        </div>
      </#if>

      <button class="btn" type="submit" style="margin-top:8px">Save password</button>
    </form>
  </#if>
</@layout.registrationLayout>
