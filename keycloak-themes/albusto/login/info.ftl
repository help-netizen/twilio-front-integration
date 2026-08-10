<#import "template.ftl" as layout>
<#--
  Albusto custom info page.

  AUTH-FLOW-FIX-002 (loop fix): AUTH-FLOW-FIX-001 auto-redirected (meta-refresh +
  window.location.replace) to Keycloak's proceed target. For execute-action
  confirm pages (e.g. Update Password) that target sends the browser back into
  this same info page, so the auto-redirect fires again → infinite reload loop.
  Reverted to Keycloak's proven, loop-free MANUAL proceed button. The terminal
  branded success page is unchanged.

  KC 26 base-info vars: skipLink, pageRedirectUri, actionUri, message.summary/type.
-->

<#assign proceedUri = "">
<#if !skipLink?? || !skipLink>
  <#if pageRedirectUri?has_content>
    <#assign proceedUri = pageRedirectUri>
  <#elseif actionUri?has_content>
    <#assign proceedUri = actionUri>
  </#if>
</#if>

<#if proceedUri?has_content>
  <#-- ===== MANUAL PROCEED — no auto-redirect, cannot loop ===== -->
  <@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
      <h1>One more step</h1>
      <p class="lede">Click continue to finish updating your account.</p>
    <#elseif section = "form">
      <#if message?has_content && (message.summary)?has_content && message.type != 'success'>
        <div class="alert alert--${message.type}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>${kcSanitize(message.summary)?no_esc}</span>
        </div>
      </#if>
      <a class="btn" href="${proceedUri}">Continue</a>
    </#if>
  </@layout.registrationLayout>
<#else>
  <#-- ===== TERMINAL: branded Albusto success page ===== -->
  <@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
      <h1>You&rsquo;re all set &#127881;</h1>
      <p class="lede">Welcome to Albusto — your email is verified and your account is ready.</p>
    <#elseif section = "form">
      <#if message?has_content && (message.summary)?has_content && message.type != 'success'>
        <div class="alert alert--${message.type}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>${kcSanitize(message.summary)?no_esc}</span>
        </div>
      </#if>

      <a class="btn" href="${properties.appUrl!'https://app.albusto.com'}">Sign in to Albusto</a>
    </#if>
  </@layout.registrationLayout>
</#if>
