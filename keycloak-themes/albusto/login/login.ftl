<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=(realm.password && realm.registrationAllowed && !registrationDisabled??); section>

  <#if section = "header">
    <h1>Welcome back</h1>
    <p class="lede">Sign in to continue to your dashboard.</p>

  <#elseif section = "form">
    <#if realm.password>
      <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post">

        <#-- Username / email -->
        <#if !usernameHidden??>
          <div class="field">
            <input id="username" name="username" type="text" tabindex="1" autofocus
                   value="${(login.username!'')}" autocomplete="username"
                   placeholder=" " spellcheck="false"
                   aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>" />
            <label for="username">
              <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>Email or username<#else>${msg("email")}</#if>
            </label>
          </div>
        </#if>

        <#-- Password -->
        <div class="field field__pw">
          <input id="password" name="password" type="password" tabindex="2"
                 <#if usernameHidden??>autofocus</#if> autocomplete="current-password"
                 placeholder=" "
                 aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>" />
          <label for="password">${msg("password")}</label>
          <button type="button" class="field__toggle" tabindex="-1" aria-label="Show password"
                  data-pw-toggle="password">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>

        <#if messagesPerField.existsError('username','password')>
          <span class="field-error" aria-live="polite">
            ${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}
          </span>
        </#if>

        <div class="row-between">
          <#if realm.rememberMe && !usernameHidden??>
            <label class="remember">
              <input id="rememberMe" name="rememberMe" type="checkbox" tabindex="3" <#if login.rememberMe??>checked</#if>>
              ${msg("rememberMe")}
            </label>
          <#else>
            <span></span>
          </#if>
          <#if realm.resetPasswordAllowed>
            <a class="link" tabindex="5" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a>
          </#if>
        </div>

        <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
        <button class="btn" name="login" id="kc-login" type="submit" tabindex="4">${msg("doLogIn")}</button>
      </form>

      <script>
        (function () {
          document.querySelectorAll('[data-pw-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var input = document.getElementById(btn.getAttribute('data-pw-toggle'));
              if (!input) return;
              input.type = input.type === 'password' ? 'text' : 'password';
              btn.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
            });
          });
        })();
      </script>
    </#if>

  <#elseif section = "info">
    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
      ${msg("noAccount")} <a tabindex="6" href="${url.registrationUrl}">${msg("doRegister")}</a>
    </#if>
  </#if>

</@layout.registrationLayout>
