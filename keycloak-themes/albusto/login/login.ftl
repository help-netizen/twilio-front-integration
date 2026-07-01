<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=(realm.password && realm.registrationAllowed && !registrationDisabled??); section>

  <#if section = "header">
    <h1>Welcome back</h1>
    <p class="lede">Sign in to continue to your dashboard.</p>

  <#elseif section = "form">
    <#-- GOOGLE-SSO-FIX-001: social sign-in (Google) on the sign-IN page, so
         existing users can log in with Google too — not just self-signup. -->
    <#if social?? && social.providers?? && (social.providers?size > 0)>
      <div class="social">
        <#list social.providers as p>
          <a id="social-${p.alias}" class="btn btn--ghost" href="${p.loginUrl}">
            <#if p.alias == "google">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
              Continue with Google
            <#else>
              ${p.displayName!}
            </#if>
          </a>
        </#list>
      </div>
      <#if realm.password>
        <div class="divider">or with email</div>
      </#if>
    </#if>

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
              <#-- AUTH-SESSION-001: default-ON so users get a persistent 30-day session
                   (survives mobile tab-discard) without hunting for the checkbox. -->
              <input id="rememberMe" name="rememberMe" type="checkbox" tabindex="3" checked>
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

      <p class="aux">New to Albusto? <a href="${properties.signupUrl!'https://app.albusto.com/signup'}">Create an account</a></p>
    </#if>

  <#elseif section = "info">
    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
      ${msg("noAccount")} <a tabindex="6" href="${url.registrationUrl}">${msg("doRegister")}</a>
    </#if>
  </#if>

</@layout.registrationLayout>
