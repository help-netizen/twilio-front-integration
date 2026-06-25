<#--
  Albusto custom login template.
  Defines registrationLayout — the chrome every login-theme page renders into.
  Left column = page-specific form (login, reset password, OTP, …).
  Right column = "Shipped recently" deploy history (generated → history.ftl).
-->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="en"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${msg("loginTitle",(realm.displayName!'Albusto'))}</title>
  <link rel="icon" href="${url.resourcesCommonPath}/img/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${url.resourcesPath}/css/albusto-login.css">
  <#if properties.scripts?has_content>
    <#list properties.scripts?split(' ') as script>
      <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
    </#list>
  </#if>
</head>
<body class="albusto ${bodyClass}">
  <div class="auth">

    <#-- ============ LEFT: form column ============ -->
    <div class="auth__form-col">
      <div class="brand">
        <div class="brand__mark">A</div>
        <div>
          <div class="brand__name">Albusto</div>
          <div class="brand__sub">Contact center</div>
        </div>
      </div>

      <div class="form-wrap">
        <#-- header section: pages provide their own heading -->
        <#nested "header">

        <#-- global feedback message (errors that aren't tied to a field) -->
        <#if displayMessage && message?has_content && (message.summary)?has_content
             && (message.type != 'warning' || !isAppInitiatedAction??)>
          <div class="alert alert--${message.type}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
            <span>${kcSanitize(message.summary)?no_esc}</span>
          </div>
        </#if>

        <#-- the page's form -->
        <#nested "form">

        <#-- social / try-another-way -->
        <#nested "socialProviders">

        <#-- extra info (registration link, etc.) -->
        <#if displayInfo>
          <div class="aux"><#nested "info"></div>
        </#if>

        <div class="form-foot"><span class="dot"></span> Secure sign-in &middot; Albusto CRM</div>
      </div>
    </div>

    <#-- ============ RIGHT: deploy history ============ -->
    <div class="auth__news-col" aria-hidden="true">
      <div class="news-head">
        <div class="eyebrow">What's new</div>
        <h2>Shipped recently</h2>
        <p>Every update that reached production, newest first.</p>
      </div>
      <div class="news-scroll">
        <#attempt>
          <#include "history.ftl">
        <#recover>
          <div class="news-empty">Release history will appear here.</div>
        </#attempt>
      </div>
    </div>

  </div>
</body>
</html>
</#macro>
