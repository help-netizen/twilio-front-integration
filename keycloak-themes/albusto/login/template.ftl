<#--
  Albusto custom login template.
  Defines registrationLayout — the chrome every login-theme page renders into.
  Left column = page-specific form (login, reset password, OTP, …).
  Right column = static "Why Albusto" benefits (hidden on mobile).
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
      </div>
    </div>

    <#-- ============ RIGHT: why Albusto ============ -->
    <div class="auth__news-col" aria-hidden="true">
      <div class="promo">
        <div class="eyebrow">Why Albusto</div>
        <h2 class="promo__title">Everything your front office needs</h2>
        <ul class="benefits">
          <li class="benefit">
            <span class="benefit__icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/></svg></span>
            <div>
              <div class="benefit__title">Free forever</div>
              <div class="benefit__text">Unlimited users, no seat fees. You only pay for calls and minutes.</div>
            </div>
          </li>
          <li class="benefit">
            <span class="benefit__icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>
            <div>
              <div class="benefit__title">Apps marketplace</div>
              <div class="benefit__text">Connect the tools you already use in a click.</div>
            </div>
          </li>
          <li class="benefit">
            <span class="benefit__icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6M3 12h12M3 17h8"/><circle cx="17.5" cy="8" r="2.5"/><path d="M19 18.5a2.5 2.5 0 1 0-3.5 0"/></svg></span>
            <div>
              <div class="benefit__title">Automation built in</div>
              <div class="benefit__text">Customer relationships and jobs, handled for you.</div>
            </div>
          </li>
          <li class="benefit">
            <span class="benefit__icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h4l2 5 4-12 2 7h6"/></svg></span>
            <div>
              <div class="benefit__title">Stay on the pulse</div>
              <div class="benefit__text">Calls, texts and email &mdash; all in one window.</div>
            </div>
          </li>
        </ul>
      </div>
    </div>

  </div>
</body>
</html>
</#macro>
