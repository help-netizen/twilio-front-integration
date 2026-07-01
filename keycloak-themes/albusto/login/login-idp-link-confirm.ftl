<#import "template.ftl" as layout>
<#--
  Albusto themed "Account already exists" page (Keycloak login-idp-link-confirm.ftl).
  Shown by the DEFAULT first-broker-login flow when a social (Google) sign-in's
  email matches an existing Albusto account. Without a theme override this fell
  back to bare Keycloak markup (our theme ships no base styles) — GOOGLE-SSO-FIX-001
  follow-up.

  NOTE: applying the auto-link flow (scripts/setup-google-idp.sh — trustEmail +
  idp-auto-link) SKIPS this page entirely: a verified Google email links silently
  to the existing account. This themed page is the fallback when auto-link is off.

  KC 26 context:
    - idpDisplayName        : the identity provider's display name (e.g. "Google")
    - url.loginAction       : POST target
    - submitAction (param)  : "linkAccount" | "updateProfile"
  The "User with email X already exists…" sentence arrives as the global message
  and is rendered by template.ftl's alert block.
-->
<@layout.registrationLayout; section>
  <#if section = "header">
    <h1>Account already exists</h1>
    <p class="lede">Choose how you&rsquo;d like to continue.</p>

  <#elseif section = "form">
    <form id="kc-idp-link-confirm" action="${url.loginAction}" method="post"
          style="display:flex; flex-direction:column; gap:10px; margin-top:4px">
      <button type="submit" class="btn" name="submitAction" id="linkAccount" value="linkAccount">
        Link ${(idpDisplayName!'Google')} to my account
      </button>
      <button type="submit" class="btn btn--ghost" name="submitAction" id="updateProfile" value="updateProfile">
        Review my profile first
      </button>
    </form>
  </#if>
</@layout.registrationLayout>
