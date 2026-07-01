<#import "template.ftl" as layout>
<#--
  Albusto themed OTP (SMS/authenticator) code entry — Keycloak login-otp.ftl.
  Hit during SMS 2FA. Without an override it fell back to unstyled base markup.
  Field name `otp` + optional credential selector are Keycloak contract.
-->
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
  <#if section = "header">
    <h1>Enter your code</h1>
    <p class="lede">Type the verification code to continue.</p>

  <#elseif section = "form">
    <form id="kc-otp-login-form" action="${url.loginAction}" method="post">
      <#if otpLogin?? && (otpLogin.userOtpCredentials?size > 1)>
        <div class="field" style="margin-bottom:14px">
          <#list otpLogin.userOtpCredentials as otpCredential>
            <label class="remember" style="margin-bottom:6px">
              <input type="radio" name="selectedCredentialId" value="${otpCredential.id}"
                     <#if otpCredential.id == otpLogin.selectedCredentialId>checked</#if> />
              ${otpCredential.userLabel}
            </label>
          </#list>
        </div>
      </#if>

      <div class="field">
        <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code"
               autofocus placeholder=" " spellcheck="false"
               aria-invalid="<#if messagesPerField.existsError('totp')>true</#if>" />
        <label for="otp">Verification code</label>
      </div>

      <#if messagesPerField.existsError('totp')>
        <span class="field-error" aria-live="polite">${kcSanitize(messagesPerField.getFirstError('totp'))?no_esc}</span>
      </#if>

      <button class="btn" name="login" id="kc-login" type="submit" style="margin-top:8px">Verify</button>
    </form>
  </#if>
</@layout.registrationLayout>
