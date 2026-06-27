<#import "template.ftl" as layout>
<#--
  Albusto custom info page.

  Overrides the Keycloak base info.ftl for two reasons:
    1) De-dupe — base info.ftl prints message.summary in its own body AND our
       registrationLayout prints it again in the global alert. We call the layout
       with displayMessage=false and render the message exactly once, here.
    2) Skip the manual "» Click here to proceed" step. When KC hands us a proceed
       target (the cross-session email-confirm), we auto-redirect to it so the user
       lands straight on the terminal success page (AUTH-FLOW-FIX-001 / D2).

  KC 26 base-info variables we rely on (reviewer: double-check on live server):
    - messageHeader        : optional heading override
    - message.summary/type : the info text + level (info|success|warning|error)
    - skipLink             : truthy => base suppresses the proceed link (terminal page)
    - pageRedirectUri      : redirect-after-action target (cross-session confirm)
    - actionUri            : same-session "continue" target
    - client.baseUrl       : app fallback link
    - requiredActions      : present when more required actions remain
-->

<#-- Does KC want us to send the user onward? (auto-proceed instead of a manual click) -->
<#assign proceedUri = "">
<#if !skipLink?? || !skipLink>
  <#if pageRedirectUri?has_content>
    <#assign proceedUri = pageRedirectUri>
  <#elseif actionUri?has_content>
    <#assign proceedUri = actionUri>
  </#if>
</#if>

<#if proceedUri?has_content>
  <#-- ============ AUTO-PROCEED: skip the "click here to proceed" interstitial ============ -->
  <@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
      <meta http-equiv="refresh" content="0;url=${proceedUri}">
      <h1>One moment…</h1>
      <p class="lede">Finishing up — taking you to the next step.</p>
    <#elseif section = "form">
      <#-- No-JS fallback: a plain link the user can click if the redirect doesn't fire. -->
      <noscript>
        <p class="aux">If you are not redirected automatically,
          <a href="${proceedUri}">continue here</a>.</p>
      </noscript>
      <script>
        // JS fallback for browsers that ignore meta-refresh. replace() = no extra history entry.
        window.location.replace("${proceedUri?js_string}");
      </script>
    </#if>
  </@layout.registrationLayout>
<#else>
  <#-- ============ TERMINAL: branded Albusto success page ============ -->
  <@layout.registrationLayout displayMessage=false; section>
    <#if section = "header">
      <h1>You&rsquo;re all set &#127881;</h1>
      <p class="lede">Welcome to Albusto — your email is verified and your account is ready.</p>
    <#elseif section = "form">
      <#--
        Show KC's own message ONCE only when it is genuinely informational
        (info/warning/error). For the terminal success ("Your account has been
        updated." / email verified) we deliberately use our own warm copy above
        and suppress the bland default phrasing.
      -->
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
