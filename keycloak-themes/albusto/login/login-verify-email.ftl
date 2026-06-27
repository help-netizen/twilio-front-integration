<#import "template.ftl" as layout>
<#--
  Albusto custom "verify your email" instruction page.
  Shown right after signup, before the user clicks the link in their inbox.

  Calls registrationLayout with displayMessage=false so the global alert does not
  duplicate the instruction text (AUTH-FLOW-FIX-001 / #1). We render the copy once.

  KC 26 base login-verify-email.ftl variables (reviewer: verify on live server):
    - user.email : the address the verification mail was sent to
    - actionUri  : "resend / continue" target; present when KC offers a re-send link
-->
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    <h1>Confirm your email</h1>
    <p class="lede">
      <#if (user.email)?has_content>
        We sent a verification link to <strong>${kcSanitize(user.email)?no_esc}</strong>.
      <#else>
        We sent you a verification link.
      </#if>
      Open it to activate your Albusto account.
    </p>

  <#elseif section = "form">
    <p class="instruction">Can&rsquo;t find it? Check your spam folder, or give it a minute to arrive.</p>

    <#if actionUri?has_content>
      <p class="aux">Didn&rsquo;t get the email?
        <a href="${actionUri}">Resend the verification link</a>.</p>
    </#if>
  </#if>
</@layout.registrationLayout>
