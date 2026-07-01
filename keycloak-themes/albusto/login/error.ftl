<#import "template.ftl" as layout>
<#--
  Albusto themed generic error page — Keycloak error.ftl.
  Shows message.summary; offers a way back to the app when client.baseUrl is set.
  displayMessage=false so we render the message once as body copy (not a duplicate alert).
-->
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    <h1>Something went wrong</h1>

  <#elseif section = "form">
    <#if message?? && message.summary?has_content>
      <div class="alert alert--error" style="margin-bottom:18px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        <span>${kcSanitize(message.summary)?no_esc}</span>
      </div>
    </#if>
    <#if client?? && client.baseUrl?has_content>
      <a href="${client.baseUrl}" class="btn">Back to Albusto</a>
    <#else>
      <a href="${properties.appUrl!'https://app.albusto.com'}" class="btn">Back to Albusto</a>
    </#if>
  </#if>
</@layout.registrationLayout>
