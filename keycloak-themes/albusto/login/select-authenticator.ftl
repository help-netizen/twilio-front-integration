<#import "template.ftl" as layout>
<#--
  Albusto themed 2FA-method picker — Keycloak select-authenticator.ftl.
  Lists auth.authenticationSelections; each posts authenticationExecution=<id>.
-->
<@layout.registrationLayout displayInfo=false; section>
  <#if section = "header">
    <h1>Choose a verification method</h1>
    <p class="lede">How would you like to confirm it&rsquo;s you?</p>

  <#elseif section = "form">
    <form id="kc-select-credential-form" action="${url.loginAction}" method="post"
          style="display:flex; flex-direction:column; gap:10px">
      <#list auth.authenticationSelections as selection>
        <button type="submit" name="authenticationExecution" value="${selection.authExecId}"
                class="btn btn--ghost" style="justify-content:flex-start; text-align:left; height:auto; padding:14px 16px">
          <span style="display:flex; flex-direction:column; gap:2px">
            <span style="font-weight:600; color:var(--blanc-ink-1)">${msg('${selection.displayName}')}</span>
            <#if selection.helpText??>
              <span style="font-weight:400; font-size:12.5px; color:var(--blanc-ink-3)">${msg('${selection.helpText}')}</span>
            </#if>
          </span>
        </button>
      </#list>
    </form>
  </#if>
</@layout.registrationLayout>
