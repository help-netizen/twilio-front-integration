--
-- PostgreSQL database dump
--

\restrict gi1XYJCescb8ejqvSwoorv2JZyrcXIQaoVfd54O7O8yCbeyZgQU4DIx6OTJ8VlF

-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgbouncer; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgbouncer;


--
-- Name: get_auth(text); Type: FUNCTION; Schema: pgbouncer; Owner: -
--

CREATE FUNCTION pgbouncer.get_auth(username text) RETURNS TABLE(username text, password text)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $_$
  SELECT rolname::TEXT, rolpassword::TEXT
  FROM pg_catalog.pg_authid
  WHERE pg_authid.rolname = $1
    AND pg_authid.rolcanlogin
    AND NOT pg_authid.rolsuper
    AND NOT pg_authid.rolreplication
    AND pg_authid.rolname <> '_crunchypgbouncer'
    AND (pg_authid.rolvaliduntil IS NULL OR pg_authid.rolvaliduntil >= CURRENT_TIMESTAMP)$_$;


--
-- Name: check_last_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_last_admin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Check legacy role column
    IF (TG_OP = 'DELETE' AND OLD.role = 'company_admin') OR
       (TG_OP = 'UPDATE' AND OLD.role = 'company_admin' AND (NEW.role != 'company_admin' OR NEW.status != 'active')) THEN
        IF NOT EXISTS (
            SELECT 1 FROM company_memberships
            WHERE company_id = OLD.company_id
              AND (role = 'company_admin' OR role_key = 'tenant_admin')
              AND status = 'active'
              AND id != OLD.id
        ) THEN
            RAISE EXCEPTION 'LAST_ADMIN_REQUIRED: Cannot remove the last admin from company %', OLD.company_id;
        END IF;
    END IF;

    -- Check new role_key column
    IF (TG_OP = 'DELETE' AND OLD.role_key = 'tenant_admin') OR
       (TG_OP = 'UPDATE' AND OLD.role_key = 'tenant_admin' AND (NEW.role_key != 'tenant_admin' OR NEW.status != 'active')) THEN
        IF NOT EXISTS (
            SELECT 1 FROM company_memberships
            WHERE company_id = OLD.company_id
              AND (role = 'company_admin' OR role_key = 'tenant_admin')
              AND status = 'active'
              AND id != OLD.id
        ) THEN
            RAISE EXCEPTION 'LAST_ADMIN_REQUIRED: Cannot remove the last admin from company %', OLD.company_id;
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_update_timeline_sms_last_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_update_timeline_sms_last_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                UPDATE timelines t SET sms_last_at = GREATEST(t.sms_last_at, NEW.last_message_at)
                FROM (
                    SELECT t2.id
                    FROM timelines t2
                    LEFT JOIN contacts co ON t2.contact_id = co.id
                    WHERE regexp_replace(COALESCE(t2.phone_e164, co.phone_e164), '[^0-9]', '', 'g') = NEW.customer_digits
                       OR (co.secondary_phone IS NOT NULL
                           AND regexp_replace(co.secondary_phone, '[^0-9]', '', 'g') = NEW.customer_digits)
                ) matched
                WHERE t.id = matched.id;
                RETURN NEW;
            END;
            $$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_event_entity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_event_entity (
    id character varying(36) NOT NULL,
    admin_event_time bigint,
    realm_id character varying(255),
    operation_type character varying(255),
    auth_realm_id character varying(255),
    auth_client_id character varying(255),
    auth_user_id character varying(255),
    ip_address character varying(255),
    resource_path character varying(2550),
    representation text,
    error character varying(255),
    resource_type character varying(64),
    details_json text
);


--
-- Name: agent_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_presence (
    company_id text NOT NULL,
    user_id text NOT NULL,
    status text DEFAULT 'offline'::text NOT NULL,
    group_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_agent_presence_status CHECK ((status = ANY (ARRAY['available'::text, 'on_call'::text, 'offline'::text])))
);


--
-- Name: api_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_integrations (
    id bigint NOT NULL,
    client_name text NOT NULL,
    key_id text NOT NULL,
    secret_hash text NOT NULL,
    scopes jsonb DEFAULT '["leads:create"]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    company_id uuid NOT NULL,
    marketplace_app_id bigint,
    marketplace_installation_id bigint
);


--
-- Name: TABLE api_integrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.api_integrations IS 'API integration credentials for external API clients and marketplace apps';


--
-- Name: COLUMN api_integrations.scopes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_integrations.scopes IS 'JSON array of integration permissions, e.g. ["leads:create"], ["analytics:read"], or ["full_access"] for trusted marketplace apps';


--
-- Name: COLUMN api_integrations.marketplace_app_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_integrations.marketplace_app_id IS 'Optional marketplace app catalog id when this credential was issued by the marketplace install flow';


--
-- Name: COLUMN api_integrations.marketplace_installation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_integrations.marketplace_installation_id IS 'Optional tenant installation id when this credential was issued by the marketplace install flow';


--
-- Name: api_integrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_integrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_integrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_integrations_id_seq OWNED BY public.api_integrations.id;


--
-- Name: associated_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.associated_policy (
    policy_id character varying(36) NOT NULL,
    associated_policy_id character varying(36) NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_id uuid,
    actor_email character varying(255),
    actor_ip inet,
    action character varying(100) NOT NULL,
    target_type character varying(50),
    target_id character varying(255),
    company_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    trace_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: authentication_execution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authentication_execution (
    id character varying(36) NOT NULL,
    alias character varying(255),
    authenticator character varying(36),
    realm_id character varying(36),
    flow_id character varying(36),
    requirement integer,
    priority integer,
    authenticator_flow boolean DEFAULT false NOT NULL,
    auth_flow_id character varying(36),
    auth_config character varying(36)
);


--
-- Name: authentication_flow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authentication_flow (
    id character varying(36) NOT NULL,
    alias character varying(255),
    description character varying(255),
    realm_id character varying(36),
    provider_id character varying(36) DEFAULT 'basic-flow'::character varying NOT NULL,
    top_level boolean DEFAULT false NOT NULL,
    built_in boolean DEFAULT false NOT NULL
);


--
-- Name: authenticator_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authenticator_config (
    id character varying(36) NOT NULL,
    alias character varying(255),
    realm_id character varying(36)
);


--
-- Name: authenticator_config_entry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authenticator_config_entry (
    authenticator_id character varying(36) NOT NULL,
    value text,
    name character varying(255) NOT NULL
);


--
-- Name: broker_link; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broker_link (
    identity_provider character varying(255) NOT NULL,
    storage_provider_id character varying(255),
    realm_id character varying(36) NOT NULL,
    broker_user_id character varying(255),
    broker_username character varying(255),
    token text,
    user_id character varying(255) NOT NULL
);


--
-- Name: call_ai_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_ai_runs (
    id text NOT NULL,
    tenant_id text NOT NULL,
    call_id text,
    call_sid text,
    flow_id text,
    node_id text,
    provider text DEFAULT 'vapi'::text NOT NULL,
    provider_connection_id text,
    provider_call_id text,
    provider_assistant_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    duration_sec integer,
    transcript_ref text,
    summary_ref text,
    recording_ref text,
    dial_call_status text,
    node_output text,
    metadata_json text DEFAULT '{}'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events (
    id bigint NOT NULL,
    call_sid character varying(100) NOT NULL,
    event_type text NOT NULL,
    event_status text,
    event_time timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    source text NOT NULL,
    payload jsonb NOT NULL,
    company_id uuid
);


--
-- Name: call_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.call_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: call_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.call_events_id_seq OWNED BY public.call_events.id;


--
-- Name: call_flow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_flow_executions (
    id text NOT NULL,
    company_id text NOT NULL,
    call_sid text NOT NULL,
    group_id text,
    flow_id text,
    current_node_id text,
    context_json text DEFAULT '{}'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_flow_node_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_flow_node_configs (
    id text NOT NULL,
    tenant_id text NOT NULL,
    flow_id text NOT NULL,
    node_id text NOT NULL,
    node_kind text DEFAULT 'vapi_agent'::text NOT NULL,
    config_json text DEFAULT '{}'::text NOT NULL,
    version text DEFAULT '1'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_flows (
    id text NOT NULL,
    company_id text NOT NULL,
    group_id text,
    name text NOT NULL,
    description text DEFAULT ''::text,
    status text DEFAULT 'active'::text NOT NULL,
    graph_json text DEFAULT '{}'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calls (
    id bigint NOT NULL,
    call_sid character varying(100) NOT NULL,
    parent_call_sid character varying(100),
    contact_id bigint,
    direction character varying(20) NOT NULL,
    from_number text,
    to_number text,
    status character varying(30) NOT NULL,
    is_final boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone,
    answered_at timestamp with time zone,
    ended_at timestamp with time zone,
    duration_sec integer,
    price numeric(10,4),
    price_unit character varying(10),
    last_event_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_last_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    company_id uuid NOT NULL,
    timeline_id bigint,
    answered_by text
);


--
-- Name: TABLE calls; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.calls IS 'Snapshot состояния звонка — 1 строка на CallSid, обновляется по событиям';


--
-- Name: COLUMN calls.is_final; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calls.is_final IS 'true когда звонок в терминальном статусе (completed/busy/failed/no-answer/canceled)';


--
-- Name: COLUMN calls.last_event_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.calls.last_event_time IS 'Guard: event_time >= last_event_time для защиты от out-of-order';


--
-- Name: calls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calls_id_seq OWNED BY public.calls.id;


--
-- Name: client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client (
    id character varying(36) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    full_scope_allowed boolean DEFAULT false NOT NULL,
    client_id character varying(255),
    not_before integer,
    public_client boolean DEFAULT false NOT NULL,
    secret character varying(255),
    base_url character varying(255),
    bearer_only boolean DEFAULT false NOT NULL,
    management_url character varying(255),
    surrogate_auth_required boolean DEFAULT false NOT NULL,
    realm_id character varying(36),
    protocol character varying(255),
    node_rereg_timeout integer DEFAULT 0,
    frontchannel_logout boolean DEFAULT false NOT NULL,
    consent_required boolean DEFAULT false NOT NULL,
    name character varying(255),
    service_accounts_enabled boolean DEFAULT false NOT NULL,
    client_authenticator_type character varying(255),
    root_url character varying(255),
    description character varying(255),
    registration_token character varying(255),
    standard_flow_enabled boolean DEFAULT true NOT NULL,
    implicit_flow_enabled boolean DEFAULT false NOT NULL,
    direct_access_grants_enabled boolean DEFAULT false NOT NULL,
    always_display_in_console boolean DEFAULT false NOT NULL
);


--
-- Name: client_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_attributes (
    client_id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    value text
);


--
-- Name: client_auth_flow_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_auth_flow_bindings (
    client_id character varying(36) NOT NULL,
    flow_id character varying(36),
    binding_name character varying(255) NOT NULL
);


--
-- Name: client_initial_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_initial_access (
    id character varying(36) NOT NULL,
    realm_id character varying(36) NOT NULL,
    "timestamp" integer,
    expiration integer,
    count integer,
    remaining_count integer
);


--
-- Name: client_node_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_node_registrations (
    client_id character varying(36) NOT NULL,
    value integer,
    name character varying(255) NOT NULL
);


--
-- Name: client_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_scope (
    id character varying(36) NOT NULL,
    name character varying(255),
    realm_id character varying(36),
    description character varying(255),
    protocol character varying(255)
);


--
-- Name: client_scope_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_scope_attributes (
    scope_id character varying(36) NOT NULL,
    value character varying(2048),
    name character varying(255) NOT NULL
);


--
-- Name: client_scope_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_scope_client (
    client_id character varying(255) NOT NULL,
    scope_id character varying(255) NOT NULL,
    default_scope boolean DEFAULT false NOT NULL
);


--
-- Name: client_scope_role_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_scope_role_mapping (
    scope_id character varying(36) NOT NULL,
    role_id character varying(36) NOT NULL
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    zenbooker_webhook_key text,
    timezone character varying(100) DEFAULT 'America/New_York'::character varying,
    locale character varying(20) DEFAULT 'en-US'::character varying,
    contact_email character varying(255),
    contact_phone character varying(50),
    billing_email character varying(255),
    created_by_user_id uuid,
    suspended_at timestamp with time zone,
    archived_at timestamp with time zone,
    status_reason text,
    zenbooker_api_key text,
    CONSTRAINT companies_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('archived'::character varying)::text, ('onboarding'::character varying)::text])))
);


--
-- Name: COLUMN companies.zenbooker_api_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.companies.zenbooker_api_key IS 'Per-tenant Zenbooker API key for data isolation';


--
-- Name: company_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role_key character varying(50) NOT NULL,
    invited_by uuid,
    keycloak_sub character varying(255),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_invitation_role_key CHECK (((role_key)::text = ANY (ARRAY[('tenant_admin'::character varying)::text, ('manager'::character varying)::text, ('dispatcher'::character varying)::text, ('provider'::character varying)::text]))),
    CONSTRAINT chk_invitation_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('expired'::character varying)::text, ('revoked'::character varying)::text])))
);


--
-- Name: TABLE company_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_invitations IS 'Tenant user invitation tracking (PF007)';


--
-- Name: company_membership_permission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_membership_permission_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    membership_id uuid NOT NULL,
    permission_key character varying(100) NOT NULL,
    override_mode character varying(10) NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_override_mode CHECK (((override_mode)::text = ANY (ARRAY[('allow'::character varying)::text, ('deny'::character varying)::text])))
);


--
-- Name: TABLE company_membership_permission_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_membership_permission_overrides IS 'Per-employee permission overrides on top of role matrix (PF007)';


--
-- Name: company_membership_scope_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_membership_scope_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    membership_id uuid NOT NULL,
    scope_key character varying(100) NOT NULL,
    scope_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE company_membership_scope_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_membership_scope_overrides IS 'Per-employee scope overrides (e.g. assigned_only, financial visibility) (PF007)';


--
-- Name: company_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    role character varying(50) DEFAULT 'company_member'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phone_calls_allowed boolean DEFAULT false NOT NULL,
    role_key character varying(50),
    is_primary boolean DEFAULT false NOT NULL,
    invited_by uuid,
    invited_at timestamp with time zone,
    activated_at timestamp with time zone,
    disabled_at timestamp with time zone,
    disabled_reason text,
    CONSTRAINT chk_membership_role CHECK (((role)::text = ANY (ARRAY[('super_admin'::character varying)::text, ('company_admin'::character varying)::text, ('company_member'::character varying)::text]))),
    CONSTRAINT chk_membership_role_key CHECK (((role_key IS NULL) OR ((role_key)::text = ANY (ARRAY[('tenant_admin'::character varying)::text, ('manager'::character varying)::text, ('dispatcher'::character varying)::text, ('provider'::character varying)::text]))))
);


--
-- Name: company_role_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_role_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    role_key character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    description text,
    is_locked boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_role_config_key CHECK (((role_key)::text = ANY (ARRAY[('tenant_admin'::character varying)::text, ('manager'::character varying)::text, ('dispatcher'::character varying)::text, ('provider'::character varying)::text])))
);


--
-- Name: TABLE company_role_configs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_role_configs IS 'Tenant-scoped configs for fixed system roles (PF007)';


--
-- Name: company_role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_config_id uuid NOT NULL,
    permission_key character varying(100) NOT NULL,
    is_allowed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE company_role_permissions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_role_permissions IS 'Permission matrix for each system role within a company';


--
-- Name: company_role_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_role_scopes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_config_id uuid NOT NULL,
    scope_key character varying(100) NOT NULL,
    scope_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE company_role_scopes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_role_scopes IS 'Advanced restriction scopes per role (e.g. job_visibility, financial_scope)';


--
-- Name: company_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_settings (
    company_id text NOT NULL,
    setting_key character varying(100) NOT NULL,
    setting_value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_user_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    membership_id uuid NOT NULL,
    phone character varying(50),
    schedule_color character varying(20) DEFAULT '#3B82F6'::character varying,
    is_provider boolean DEFAULT false NOT NULL,
    call_masking_enabled boolean DEFAULT false NOT NULL,
    location_tracking_enabled boolean DEFAULT false NOT NULL,
    phone_calls_allowed boolean DEFAULT false NOT NULL,
    job_close_mode character varying(30) DEFAULT 'close'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_job_close_mode CHECK (((job_close_mode)::text = ANY (ARRAY[('close'::character varying)::text, ('done_pending_approval'::character varying)::text])))
);


--
-- Name: TABLE company_user_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_user_profiles IS 'Per-membership user profile with field-tech attributes (PF007)';


--
-- Name: company_user_service_areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_user_service_areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    membership_id uuid NOT NULL,
    service_area_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE company_user_service_areas; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_user_service_areas IS 'User-to-service-area restrictions (PF007)';


--
-- Name: company_user_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_user_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    membership_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE company_user_skills; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_user_skills IS 'User-to-job-type/skill restrictions (PF007)';


--
-- Name: component; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.component (
    id character varying(36) NOT NULL,
    name character varying(255),
    parent_id character varying(36),
    provider_id character varying(36),
    provider_type character varying(255),
    realm_id character varying(36),
    sub_type character varying(255)
);


--
-- Name: component_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.component_config (
    id character varying(36) NOT NULL,
    component_id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    value text
);


--
-- Name: composite_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.composite_role (
    composite character varying(36) NOT NULL,
    child_role character varying(36) NOT NULL
);


--
-- Name: contact_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_addresses (
    id bigint NOT NULL,
    contact_id bigint NOT NULL,
    label text,
    is_primary boolean DEFAULT false,
    street_line1 text DEFAULT ''::text NOT NULL,
    street_line2 text,
    city text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    postal_code text DEFAULT ''::text NOT NULL,
    country text DEFAULT 'US'::text NOT NULL,
    google_place_id text,
    lat double precision,
    lng double precision,
    address_normalized_hash text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    zenbooker_address_id text,
    zenbooker_customer_id text
);


--
-- Name: contact_addresses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.contact_addresses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.contact_addresses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: contact_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_emails (
    id bigint NOT NULL,
    contact_id bigint NOT NULL,
    email text NOT NULL,
    email_normalized text NOT NULL,
    is_primary boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: contact_emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.contact_emails ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.contact_emails_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id bigint NOT NULL,
    full_name text,
    phone_e164 text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid NOT NULL,
    has_unread boolean DEFAULT false,
    last_incoming_event_at timestamp with time zone,
    last_read_at timestamp with time zone,
    zenbooker_data jsonb DEFAULT '{}'::jsonb,
    secondary_phone text,
    first_name text,
    last_name text,
    company_name text,
    notes text,
    zenbooker_customer_id text,
    secondary_phone_name text,
    zenbooker_account_id text,
    zenbooker_synced_at timestamp with time zone,
    zenbooker_sync_status text DEFAULT 'not_linked'::text,
    zenbooker_last_error text,
    structured_notes jsonb DEFAULT '[]'::jsonb
);


--
-- Name: TABLE contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contacts IS 'Клиенты и их контактные идентификаторы';


--
-- Name: contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contacts_id_seq OWNED BY public.contacts.id;


--
-- Name: credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential (
    id character varying(36) NOT NULL,
    salt bytea,
    type character varying(255),
    user_id character varying(36),
    created_date bigint,
    user_label character varying(255),
    secret_data text,
    credential_data text,
    priority integer
);


--
-- Name: crm_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    keycloak_sub character varying(255) NOT NULL,
    email character varying(255),
    full_name character varying(255),
    role character varying(50) DEFAULT 'company_member'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid,
    platform_role character varying(50) DEFAULT 'none'::character varying NOT NULL,
    primary_membership_id uuid,
    onboarding_status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    last_invited_at timestamp with time zone,
    CONSTRAINT crm_users_onboarding_status_check CHECK (((onboarding_status)::text = ANY (ARRAY[('invited'::character varying)::text, ('active'::character varying)::text, ('disabled'::character varying)::text]))),
    CONSTRAINT crm_users_platform_role_check CHECK (((platform_role)::text = ANY (ARRAY[('none'::character varying)::text, ('super_admin'::character varying)::text]))),
    CONSTRAINT crm_users_role_check CHECK (((role)::text = ANY (ARRAY[('super_admin'::character varying)::text, ('company_admin'::character varying)::text, ('company_member'::character varying)::text, ('viewer'::character varying)::text])))
);


--
-- Name: daily_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_metrics (
    id integer NOT NULL,
    date date NOT NULL,
    source character varying(100),
    segment character varying(50),
    leads integer DEFAULT 0,
    units integer DEFAULT 0,
    repairs integer DEFAULT 0,
    revenue_gross numeric(10,2) DEFAULT 0,
    revenue40 numeric(10,2) DEFAULT 0,
    cost numeric(10,2) DEFAULT 0,
    profit numeric(10,2) DEFAULT 0,
    calls integer DEFAULT 0,
    google_spend numeric(10,2) DEFAULT 0,
    cpl numeric(10,2),
    conv_l_to_r numeric(5,4),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: daily_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_metrics_id_seq OWNED BY public.daily_metrics.id;


--
-- Name: databasechangelog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.databasechangelog (
    id character varying(255) NOT NULL,
    author character varying(255) NOT NULL,
    filename character varying(255) NOT NULL,
    dateexecuted timestamp without time zone NOT NULL,
    orderexecuted integer NOT NULL,
    exectype character varying(10) NOT NULL,
    md5sum character varying(35),
    description character varying(255),
    comments character varying(255),
    tag character varying(255),
    liquibase character varying(20),
    contexts character varying(255),
    labels character varying(255),
    deployment_id character varying(10)
);


--
-- Name: databasechangeloglock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.databasechangeloglock (
    id integer NOT NULL,
    locked boolean NOT NULL,
    lockgranted timestamp without time zone,
    lockedby character varying(255)
);


--
-- Name: default_client_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.default_client_scope (
    realm_id character varying(36) NOT NULL,
    scope_id character varying(36) NOT NULL,
    default_scope boolean DEFAULT false NOT NULL
);


--
-- Name: dim_date; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dim_date (
    d date NOT NULL
);


--
-- Name: dim_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dim_source (
    id integer NOT NULL,
    code text NOT NULL,
    name text
);


--
-- Name: dim_source_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dim_source_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dim_source_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dim_source_id_seq OWNED BY public.dim_source.id;


--
-- Name: dim_zip; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dim_zip (
    zip character varying(10) NOT NULL,
    city text,
    state text,
    lat numeric(9,6),
    lon numeric(9,6),
    service_zone text
);


--
-- Name: dispatch_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_settings (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    timezone character varying(100) DEFAULT 'America/New_York'::character varying NOT NULL,
    work_start_time time without time zone DEFAULT '08:00:00'::time without time zone NOT NULL,
    work_end_time time without time zone DEFAULT '18:00:00'::time without time zone NOT NULL,
    work_days smallint[] DEFAULT '{1,2,3,4,5}'::smallint[] NOT NULL,
    slot_duration integer DEFAULT 60 NOT NULL,
    buffer_minutes integer DEFAULT 0 NOT NULL,
    settings_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE dispatch_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dispatch_settings IS 'PF001: Company-level dispatch/schedule configuration';


--
-- Name: dispatch_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_settings_id_seq OWNED BY public.dispatch_settings.id;


--
-- Name: document_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_attachments (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    document_type character varying(20) NOT NULL,
    document_id bigint NOT NULL,
    attachment_kind character varying(30) DEFAULT 'pdf'::character varying NOT NULL,
    revision_number integer,
    file_name character varying(255) NOT NULL,
    content_type character varying(100),
    file_size integer,
    storage_key text NOT NULL,
    checksum_sha256 character varying(64),
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_attachments_attachment_kind_check CHECK (((attachment_kind)::text = ANY (ARRAY[('pdf'::character varying)::text, ('generated_pdf'::character varying)::text, ('photo'::character varying)::text, ('signature'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT document_attachments_document_type_check CHECK (((document_type)::text = ANY (ARRAY[('estimate'::character varying)::text, ('invoice'::character varying)::text])))
);


--
-- Name: TABLE document_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_attachments IS 'PF002+PF003: Shared file storage references for document PDFs and attachments';


--
-- Name: document_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_attachments_id_seq OWNED BY public.document_attachments.id;


--
-- Name: document_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_deliveries (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    document_type character varying(20) NOT NULL,
    document_id bigint NOT NULL,
    delivery_method character varying(20) NOT NULL,
    recipient_email character varying(255),
    recipient_phone character varying(30),
    subject text,
    body text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    provider_message_id character varying(255),
    portal_token_id uuid,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    failure_reason text,
    sent_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_deliveries_delivery_method_check CHECK (((delivery_method)::text = ANY (ARRAY[('email'::character varying)::text, ('sms'::character varying)::text, ('portal_link'::character varying)::text, ('manual'::character varying)::text]))),
    CONSTRAINT document_deliveries_document_type_check CHECK (((document_type)::text = ANY (ARRAY[('estimate'::character varying)::text, ('invoice'::character varying)::text]))),
    CONSTRAINT document_deliveries_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('sent'::character varying)::text, ('delivered'::character varying)::text, ('failed'::character varying)::text, ('bounced'::character varying)::text])))
);


--
-- Name: TABLE document_deliveries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_deliveries IS 'PF002+PF003: Shared delivery tracking for estimate/invoice documents';


--
-- Name: document_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_deliveries_id_seq OWNED BY public.document_deliveries.id;


--
-- Name: document_delivery_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_delivery_attachments (
    delivery_id bigint NOT NULL,
    attachment_id bigint NOT NULL,
    disposition character varying(20) DEFAULT 'attachment'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_delivery_attachments_disposition_check CHECK (((disposition)::text = ANY (ARRAY[('attachment'::character varying)::text, ('inline'::character varying)::text])))
);


--
-- Name: TABLE document_delivery_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_delivery_attachments IS 'PF002+PF003: Many-to-many link between deliveries and attachments';


--
-- Name: domain_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_events (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    aggregate_type character varying(50) NOT NULL,
    aggregate_id character varying(255) NOT NULL,
    event_type character varying(100) NOT NULL,
    event_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_type character varying(20) DEFAULT 'system'::character varying NOT NULL,
    actor_id character varying(255),
    idempotency_key character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT domain_events_actor_type_check CHECK (((actor_type)::text = ANY (ARRAY[('user'::character varying)::text, ('system'::character varying)::text, ('client'::character varying)::text, ('webhook'::character varying)::text])))
);


--
-- Name: TABLE domain_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.domain_events IS 'Infrastructure: Canonical event sourcing table for all business domain events';


--
-- Name: domain_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.domain_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: domain_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.domain_events_id_seq OWNED BY public.domain_events.id;


--
-- Name: elocals_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.elocals_leads (
    id integer NOT NULL,
    lead_id character varying(255),
    date date NOT NULL,
    lead_type character varying(100),
    status character varying(50),
    cost numeric(10,2) DEFAULT 0,
    current_status character varying(50),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    unique_id character varying(255),
    "time" timestamp with time zone,
    duration integer,
    forwarding_number character varying(50),
    caller_id character varying(50),
    caller_name character varying(255),
    profile character varying(255),
    service_city character varying(100),
    service_state character varying(50),
    service_zip character varying(20),
    recording_url text,
    profile_name character varying(255),
    dispositions text,
    dollar_value numeric(10,2),
    notes text,
    contact_first_name character varying(100),
    contact_last_name character varying(100),
    contact_phone character varying(50),
    contact_extension character varying(20),
    contact_cell_phone character varying(50),
    contact_email character varying(255),
    contact_address text,
    contact_city character varying(100),
    contact_state character varying(50),
    contact_zip character varying(20),
    raw_data jsonb
);


--
-- Name: elocals_leads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.elocals_leads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: elocals_leads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.elocals_leads_id_seq OWNED BY public.elocals_leads.id;


--
-- Name: email_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_attachments (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    message_id bigint NOT NULL,
    provider_attachment_id text,
    part_id text,
    file_name text,
    content_type text,
    file_size integer,
    is_inline boolean DEFAULT false NOT NULL,
    content_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_attachments_id_seq OWNED BY public.email_attachments.id;


--
-- Name: email_mailboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_mailboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    provider text NOT NULL,
    email_address text NOT NULL,
    display_name text,
    provider_account_id text,
    status text DEFAULT 'connected'::text NOT NULL,
    access_token_encrypted text,
    refresh_token_encrypted text,
    token_expires_at timestamp with time zone,
    history_id text,
    last_synced_at timestamp with time zone,
    last_sync_status text DEFAULT 'ok'::text,
    last_sync_error text,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_mailboxes_last_sync_status_check CHECK ((last_sync_status = ANY (ARRAY['ok'::text, 'running'::text, 'error'::text, 'backfill_required'::text]))),
    CONSTRAINT email_mailboxes_provider_check CHECK ((provider = 'gmail'::text)),
    CONSTRAINT email_mailboxes_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'reconnect_required'::text, 'sync_error'::text, 'disconnected'::text])))
);


--
-- Name: email_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_messages (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    thread_id bigint NOT NULL,
    provider_message_id text NOT NULL,
    provider_thread_id text,
    message_id_header text,
    in_reply_to_header text,
    references_header text,
    direction text NOT NULL,
    from_name text,
    from_email text,
    to_recipients_json jsonb DEFAULT '[]'::jsonb,
    cc_recipients_json jsonb DEFAULT '[]'::jsonb,
    subject text,
    snippet text,
    body_text text,
    body_html text,
    has_attachments boolean DEFAULT false NOT NULL,
    gmail_internal_at timestamp with time zone,
    sent_by_user_id text,
    sent_by_user_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: email_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_messages_id_seq OWNED BY public.email_messages.id;


--
-- Name: email_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_sync_state (
    mailbox_id uuid NOT NULL,
    company_id uuid NOT NULL,
    last_history_id text,
    initial_backfill_completed_at timestamp with time zone,
    last_sync_started_at timestamp with time zone,
    last_sync_finished_at timestamp with time zone,
    last_sync_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_threads (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    provider_thread_id text NOT NULL,
    subject text,
    participants_json jsonb DEFAULT '[]'::jsonb,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_message_direction text,
    last_message_from text,
    unread_count integer DEFAULT 0 NOT NULL,
    has_attachments boolean DEFAULT false NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_threads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_threads_id_seq OWNED BY public.email_threads.id;


--
-- Name: estimate_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_events (
    id bigint NOT NULL,
    estimate_id bigint NOT NULL,
    event_type character varying(50) NOT NULL,
    actor_type character varying(20) DEFAULT 'user'::character varying NOT NULL,
    actor_id character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT estimate_events_actor_type_check CHECK (((actor_type)::text = ANY (ARRAY[('user'::character varying)::text, ('system'::character varying)::text, ('client'::character varying)::text])))
);


--
-- Name: TABLE estimate_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.estimate_events IS 'PF002: Audit trail for estimate lifecycle events';


--
-- Name: estimate_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estimate_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estimate_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estimate_events_id_seq OWNED BY public.estimate_events.id;


--
-- Name: estimate_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_items (
    id bigint NOT NULL,
    estimate_id bigint NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    name text NOT NULL,
    description text,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    unit character varying(20),
    unit_price numeric(12,2) DEFAULT 0 NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    item_type text,
    category_id bigint,
    price_book_item_id bigint,
    CONSTRAINT estimate_items_quantity_positive_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT estimate_items_unit_price_nonnegative_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: TABLE estimate_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.estimate_items IS 'PF002: Line items for estimate documents';


--
-- Name: estimate_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estimate_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estimate_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estimate_items_id_seq OWNED BY public.estimate_items.id;


--
-- Name: estimate_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimate_revisions (
    id bigint NOT NULL,
    estimate_id bigint NOT NULL,
    revision_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE estimate_revisions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.estimate_revisions IS 'PF002: Immutable revision snapshots for estimates';


--
-- Name: estimate_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estimate_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estimate_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estimate_revisions_id_seq OWNED BY public.estimate_revisions.id;


--
-- Name: estimates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimates (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    estimate_number character varying(50) NOT NULL,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    contact_id bigint,
    lead_id bigint,
    job_id bigint,
    title text,
    notes text,
    internal_note text,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(7,4) DEFAULT 0 NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    deposit_required boolean DEFAULT false NOT NULL,
    deposit_type character varying(20),
    deposit_value numeric(12,2),
    deposit_paid numeric(12,2) DEFAULT 0 NOT NULL,
    signature_required boolean DEFAULT false NOT NULL,
    signed_at timestamp with time zone,
    valid_until timestamp with time zone,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    discount_type character varying(20),
    discount_value numeric(12,2) DEFAULT 0 NOT NULL,
    estimate_sequence integer DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    approved_snapshot jsonb,
    signature_name text,
    signature_consented_at timestamp with time zone,
    CONSTRAINT estimates_deposit_type_check CHECK (((deposit_type)::text = ANY (ARRAY[('fixed'::character varying)::text, ('percentage'::character varying)::text]))),
    CONSTRAINT estimates_discount_type_check CHECK (((discount_type IS NULL) OR ((discount_type)::text = ANY (ARRAY[('fixed'::character varying)::text, ('percentage'::character varying)::text])))),
    CONSTRAINT estimates_estimate_sequence_check CHECK ((estimate_sequence > 0)),
    CONSTRAINT estimates_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('sent'::character varying)::text, ('viewed'::character varying)::text, ('approved'::character varying)::text, ('declined'::character varying)::text])))
);


--
-- Name: TABLE estimates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.estimates IS 'PF002: Client-facing estimate/quote documents';


--
-- Name: estimates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estimates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estimates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estimates_id_seq OWNED BY public.estimates.id;


--
-- Name: event_entity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_entity (
    id character varying(36) NOT NULL,
    client_id character varying(255),
    details_json character varying(2550),
    error character varying(255),
    ip_address character varying(255),
    realm_id character varying(255),
    session_id character varying(255),
    event_time bigint,
    type character varying(255),
    user_id character varying(255),
    details_json_long_value text
);


--
-- Name: fact_expense; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_expense (
    expense_id integer NOT NULL,
    expense_date date NOT NULL,
    expense_category text NOT NULL,
    amount numeric(10,2) NOT NULL,
    vendor text,
    channel_id integer,
    job_id character varying(255),
    meta jsonb,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: fact_expense_expense_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fact_expense_expense_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fact_expense_expense_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fact_expense_expense_id_seq OWNED BY public.fact_expense.expense_id;


--
-- Name: fact_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_jobs (
    job_id character varying(255) NOT NULL,
    lead_id character varying(255),
    created_at timestamp without time zone NOT NULL,
    scheduled_at timestamp without time zone,
    source_id integer,
    type text,
    client_id character varying(255),
    meta jsonb,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    serial_id integer,
    technician_name text,
    job_amount_due numeric(10,2),
    job_total_price numeric(10,2),
    job_end_date_time timestamp without time zone,
    last_status_update timestamp without time zone,
    phone text,
    second_phone text,
    phone_ext text,
    second_phone_ext text,
    email text,
    first_name text,
    last_name text,
    company text,
    address text,
    city text,
    state text,
    postal_code text,
    country text,
    latitude text,
    longitude text,
    sub_total numeric(10,2),
    item_cost numeric(10,2),
    tech_cost numeric(10,2),
    sub_status text,
    payment_due_date timestamp without time zone,
    job_notes text,
    comments text,
    timezone text,
    referral_company text,
    service_area text,
    created_by text,
    tags jsonb,
    team jsonb,
    import_source text,
    status text
);


--
-- Name: fact_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_leads (
    lead_id character varying(255) NOT NULL,
    created_at timestamp without time zone NOT NULL,
    source_id integer,
    phone_hash text,
    raw_source text,
    cost numeric(10,2) DEFAULT 0,
    meta jsonb,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    serial_id integer,
    lead_date_time timestamp without time zone,
    lead_end_date_time timestamp without time zone,
    last_status_update timestamp without time zone,
    status character varying(255),
    sub_status character varying(255),
    phone character varying(20),
    second_phone character varying(20),
    phone_ext character varying(10),
    second_phone_ext character varying(10),
    email character varying(255),
    first_name character varying(100),
    last_name character varying(100),
    company character varying(255),
    client_phone character varying(20),
    client_name character varying(255),
    address character varying(255),
    city character varying(100),
    state character varying(50),
    postal_code character varying(10),
    country character varying(50),
    latitude character varying(50),
    longitude character varying(50),
    unit character varying(50),
    job_type character varying(255),
    job_source character varying(255),
    referral_company character varying(500),
    service_area character varying(255),
    timezone character varying(100),
    created_by character varying(255),
    notes text,
    comments text,
    job_id character varying(255),
    tags jsonb,
    team jsonb,
    source character varying(100),
    import_source text
);


--
-- Name: fact_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_parts (
    part_id integer NOT NULL,
    job_id character varying(255),
    part_sku text,
    part_name text,
    part_cost numeric(10,2) DEFAULT 0,
    part_revenue numeric(10,2) DEFAULT 0,
    ordered_at timestamp without time zone,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: fact_parts_part_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fact_parts_part_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fact_parts_part_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fact_parts_part_id_seq OWNED BY public.fact_parts.part_id;


--
-- Name: fact_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_payments (
    payment_id character varying(255) NOT NULL,
    job_id character varying(255),
    paid_at timestamp without time zone,
    amount numeric(10,2) NOT NULL,
    method text,
    meta jsonb,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: fed_user_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_attribute (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36),
    value character varying(2024),
    long_value_hash bytea,
    long_value_hash_lower_case bytea,
    long_value text
);


--
-- Name: fed_user_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_consent (
    id character varying(36) NOT NULL,
    client_id character varying(255),
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36),
    created_date bigint,
    last_updated_date bigint,
    client_storage_provider character varying(36),
    external_client_id character varying(255)
);


--
-- Name: fed_user_consent_cl_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_consent_cl_scope (
    user_consent_id character varying(36) NOT NULL,
    scope_id character varying(36) NOT NULL
);


--
-- Name: fed_user_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_credential (
    id character varying(36) NOT NULL,
    salt bytea,
    type character varying(255),
    created_date bigint,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36),
    user_label character varying(255),
    secret_data text,
    credential_data text,
    priority integer
);


--
-- Name: fed_user_group_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_group_membership (
    group_id character varying(36) NOT NULL,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36)
);


--
-- Name: fed_user_required_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_required_action (
    required_action character varying(255) DEFAULT ' '::character varying NOT NULL,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36)
);


--
-- Name: fed_user_role_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fed_user_role_mapping (
    role_id character varying(36) NOT NULL,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    storage_provider_id character varying(36)
);


--
-- Name: federated_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federated_identity (
    identity_provider character varying(255) NOT NULL,
    realm_id character varying(36),
    federated_user_id character varying(255),
    federated_username character varying(255),
    token text,
    user_id character varying(36) NOT NULL
);


--
-- Name: federated_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federated_user (
    id character varying(255) NOT NULL,
    storage_provider_id character varying(255),
    realm_id character varying(36) NOT NULL
);


--
-- Name: fsm_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsm_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    machine_key character varying(50) NOT NULL,
    version_id uuid,
    actor_id character varying(200),
    actor_email character varying(200),
    action character varying(50) NOT NULL,
    payload_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE fsm_audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fsm_audit_log IS 'FSM: Append-only audit log of all admin actions';


--
-- Name: fsm_machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsm_machines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    machine_key character varying(50) NOT NULL,
    company_id uuid NOT NULL,
    title character varying(200),
    description text,
    active_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE fsm_machines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fsm_machines IS 'FSM: Registered state machine definitions per company';


--
-- Name: fsm_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fsm_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    machine_id uuid NOT NULL,
    company_id uuid NOT NULL,
    version_number integer DEFAULT 1 NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    scxml_source text NOT NULL,
    change_note text,
    created_by character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by character varying(200),
    published_at timestamp with time zone,
    CONSTRAINT fsm_versions_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('published'::character varying)::text, ('archived'::character varying)::text])))
);


--
-- Name: TABLE fsm_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fsm_versions IS 'FSM: Immutable versioned snapshots of machine SCXML definitions';


--
-- Name: google_spend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_spend (
    id integer NOT NULL,
    date date NOT NULL,
    month date NOT NULL,
    campaign character varying(255),
    amount numeric(10,2) NOT NULL,
    impressions integer,
    clicks integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: google_spend_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.google_spend_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: google_spend_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.google_spend_id_seq OWNED BY public.google_spend.id;


--
-- Name: group_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_attribute (
    id character varying(36) DEFAULT 'sybase-needs-something-here'::character varying NOT NULL,
    name character varying(255) NOT NULL,
    value character varying(255),
    group_id character varying(36) NOT NULL
);


--
-- Name: group_role_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_role_mapping (
    role_id character varying(36) NOT NULL,
    group_id character varying(36) NOT NULL
);


--
-- Name: identity_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_provider (
    internal_id character varying(36) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    provider_alias character varying(255),
    provider_id character varying(255),
    store_token boolean DEFAULT false NOT NULL,
    authenticate_by_default boolean DEFAULT false NOT NULL,
    realm_id character varying(36),
    add_token_role boolean DEFAULT true NOT NULL,
    trust_email boolean DEFAULT false NOT NULL,
    first_broker_login_flow_id character varying(36),
    post_broker_login_flow_id character varying(36),
    provider_display_name character varying(255),
    link_only boolean DEFAULT false NOT NULL,
    organization_id character varying(255),
    hide_on_login boolean DEFAULT false
);


--
-- Name: identity_provider_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_provider_config (
    identity_provider_id character varying(36) NOT NULL,
    value text,
    name character varying(255) NOT NULL
);


--
-- Name: identity_provider_mapper; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_provider_mapper (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    idp_alias character varying(255) NOT NULL,
    idp_mapper_name character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL
);


--
-- Name: idp_mapper_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idp_mapper_config (
    idp_mapper_id character varying(36) NOT NULL,
    value text,
    name character varying(255) NOT NULL
);


--
-- Name: invoice_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_events (
    id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    event_type character varying(50) NOT NULL,
    actor_type character varying(20) DEFAULT 'user'::character varying NOT NULL,
    actor_id character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoice_events_actor_type_check CHECK (((actor_type)::text = ANY (ARRAY[('user'::character varying)::text, ('system'::character varying)::text, ('client'::character varying)::text])))
);


--
-- Name: TABLE invoice_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_events IS 'PF003: Audit trail for invoice lifecycle events';


--
-- Name: invoice_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_events_id_seq OWNED BY public.invoice_events.id;


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    name text NOT NULL,
    description text,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    unit character varying(20),
    unit_price numeric(12,2) DEFAULT 0 NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE invoice_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_items IS 'PF003: Line items for invoice documents';


--
-- Name: invoice_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_items_id_seq OWNED BY public.invoice_items.id;


--
-- Name: invoice_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_revisions (
    id bigint NOT NULL,
    invoice_id bigint NOT NULL,
    revision_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE invoice_revisions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_revisions IS 'PF003: Immutable revision snapshots for invoices';


--
-- Name: invoice_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_revisions_id_seq OWNED BY public.invoice_revisions.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    invoice_number character varying(50) NOT NULL,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    contact_id bigint,
    lead_id bigint,
    job_id bigint,
    estimate_id bigint,
    title text,
    notes text,
    internal_note text,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(7,4) DEFAULT 0 NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
    balance_due numeric(12,2) DEFAULT 0 NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    payment_terms character varying(30),
    due_date timestamp with time zone,
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    voided_at timestamp with time zone,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('sent'::character varying)::text, ('viewed'::character varying)::text, ('partial'::character varying)::text, ('paid'::character varying)::text, ('overdue'::character varying)::text, ('void'::character varying)::text, ('refunded'::character varying)::text])))
);


--
-- Name: TABLE invoices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoices IS 'PF003: Client-facing invoice documents';


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: job_tag_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_tag_assignments (
    job_id integer NOT NULL,
    tag_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: job_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_tags (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(7) DEFAULT ((((((chr(35) || chr(54)) || chr(66)) || chr(55)) || chr(50)) || chr(56)) || chr(48)) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: job_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_tags_id_seq OWNED BY public.job_tags.id;


--
-- Name: job_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_uuid character varying(255) NOT NULL,
    job_serial_id integer,
    customer_id character varying(255) NOT NULL,
    token text NOT NULL,
    customer_email character varying(255),
    customer_phone character varying(255),
    customer_first_name character varying(255),
    customer_last_name character varying(255),
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    sent_via character varying(50),
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    meta jsonb,
    lead_id character varying(255),
    source_id character varying(255),
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_sent_via CHECK ((((sent_via)::text = ANY (ARRAY[('email'::character varying)::text, ('sms'::character varying)::text, ('both'::character varying)::text])) OR (sent_via IS NULL))),
    CONSTRAINT chk_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('sent'::character varying)::text, ('expired'::character varying)::text, ('used'::character varying)::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    lead_id bigint,
    contact_id bigint,
    zenbooker_job_id text,
    blanc_status character varying(80) DEFAULT 'Submitted'::character varying NOT NULL,
    zb_status character varying(40) DEFAULT 'scheduled'::character varying,
    zb_rescheduled boolean DEFAULT false NOT NULL,
    zb_canceled boolean DEFAULT false NOT NULL,
    job_number text,
    service_name text,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    customer_name text,
    customer_phone text,
    customer_email text,
    address text,
    territory text,
    invoice_total text,
    invoice_status text,
    assigned_techs jsonb DEFAULT '[]'::jsonb,
    notes jsonb DEFAULT '[]'::jsonb,
    zb_raw jsonb DEFAULT '{}'::jsonb,
    company_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    job_type character varying(80),
    job_source character varying(80),
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    comments text,
    lat double precision,
    lng double precision,
    tags text[] DEFAULT ARRAY[]::text[]
);


--
-- Name: TABLE jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.jobs IS 'Local Blanc jobs storage with Zenbooker sync';


--
-- Name: COLUMN jobs.job_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.job_type IS 'Job type (same as lead job_type, from settings)';


--
-- Name: COLUMN jobs.job_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.job_source IS 'Job source (eLocals, ServiceDirect, etc.)';


--
-- Name: COLUMN jobs.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.description IS 'Job description / notes';


--
-- Name: COLUMN jobs.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.metadata IS 'Custom metadata fields from lead_custom_fields settings';


--
-- Name: COLUMN jobs.comments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.comments IS 'Internal comments';


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;


--
-- Name: keycloak_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keycloak_group (
    id character varying(36) NOT NULL,
    name character varying(255),
    parent_group character varying(36) NOT NULL,
    realm_id character varying(36),
    type integer DEFAULT 0 NOT NULL
);


--
-- Name: keycloak_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keycloak_role (
    id character varying(36) NOT NULL,
    client_realm_constraint character varying(255),
    client_role boolean DEFAULT false NOT NULL,
    description character varying(255),
    name character varying(255),
    realm_id character varying(255),
    client character varying(36),
    realm character varying(36)
);


--
-- Name: kpi_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kpi_targets (
    id integer NOT NULL,
    period_type text NOT NULL,
    period_start date NOT NULL,
    source text,
    metric text NOT NULL,
    target_value numeric NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT kpi_targets_period_type_check CHECK ((period_type = ANY (ARRAY['month'::text, 'day'::text])))
);


--
-- Name: kpi_targets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kpi_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kpi_targets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.kpi_targets_id_seq OWNED BY public.kpi_targets.id;


--
-- Name: lead_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_custom_fields (
    id bigint NOT NULL,
    display_name text NOT NULL,
    api_name text NOT NULL,
    field_type text DEFAULT 'text'::text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_searchable boolean DEFAULT true NOT NULL,
    company_id uuid NOT NULL,
    CONSTRAINT lead_custom_fields_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'textarea'::text, 'number'::text, 'file'::text, 'richtext'::text])))
);


--
-- Name: TABLE lead_custom_fields; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.lead_custom_fields IS 'Lead form field definitions (system + custom)';


--
-- Name: lead_custom_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lead_custom_fields_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lead_custom_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lead_custom_fields_id_seq OWNED BY public.lead_custom_fields.id;


--
-- Name: lead_job_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_job_types (
    id bigint NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: TABLE lead_job_types; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.lead_job_types IS 'Configurable list of job types for leads';


--
-- Name: lead_job_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lead_job_types_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lead_job_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lead_job_types_id_seq OWNED BY public.lead_job_types.id;


--
-- Name: lead_team_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_team_assignments (
    id bigint NOT NULL,
    lead_id bigint NOT NULL,
    user_name text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: lead_team_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lead_team_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lead_team_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lead_team_assignments_id_seq OWNED BY public.lead_team_assignments.id;


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id bigint NOT NULL,
    uuid character varying NOT NULL,
    serial_id integer NOT NULL,
    status character varying DEFAULT 'Submitted'::character varying NOT NULL,
    sub_status character varying,
    lead_lost boolean DEFAULT false NOT NULL,
    first_name character varying,
    last_name character varying,
    company character varying,
    phone character varying,
    phone_ext character varying,
    second_phone character varying,
    second_phone_ext character varying,
    email character varying,
    address character varying,
    unit character varying,
    city character varying,
    state character varying,
    postal_code character varying,
    country character varying,
    latitude numeric,
    longitude numeric,
    job_type character varying,
    job_source character varying,
    referral_company character varying,
    timezone character varying,
    lead_notes text,
    comments text,
    tags text[],
    lead_date_time timestamp with time zone,
    lead_end_date_time timestamp with time zone,
    payment_due_date timestamp with time zone,
    converted_to_job boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    zenbooker_job_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    company_id uuid NOT NULL,
    contact_id integer,
    contact_address_id bigint,
    second_phone_name text,
    structured_notes jsonb DEFAULT '[]'::jsonb
);


--
-- Name: COLUMN leads.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.leads.metadata IS 'Custom metadata fields defined in lead_custom_fields settings';


--
-- Name: leads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leads_id_seq OWNED BY public.leads.id;


--
-- Name: leads_legacy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads_legacy (
    lead_id character varying(255) NOT NULL,
    source character varying(100) NOT NULL,
    status character varying(100) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    job_id character varying(255),
    client_phone character varying(50),
    client_name character varying(255),
    raw_payload jsonb,
    created_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at_db timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: leads_serial_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leads_serial_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leads_serial_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leads_serial_id_seq OWNED BY public.leads.serial_id;


--
-- Name: marketplace_apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_apps (
    id bigint NOT NULL,
    app_key text NOT NULL,
    name text NOT NULL,
    provider_name text NOT NULL,
    category text NOT NULL,
    app_type text DEFAULT 'external'::text NOT NULL,
    short_description text NOT NULL,
    long_description text,
    logo_url text,
    docs_url text,
    support_email text,
    privacy_url text,
    requested_scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    provisioning_mode text DEFAULT 'manual'::text NOT NULL,
    provisioning_url text,
    status text DEFAULT 'draft'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_marketplace_apps_https_provisioning CHECK (((provisioning_mode <> 'push_credentials'::text) OR (provisioning_url ~ '^https://'::text))),
    CONSTRAINT chk_marketplace_apps_scopes_array CHECK ((jsonb_typeof(requested_scopes) = 'array'::text)),
    CONSTRAINT marketplace_apps_app_type_check CHECK ((app_type = ANY (ARRAY['external'::text, 'internal'::text, 'private'::text]))),
    CONSTRAINT marketplace_apps_provisioning_mode_check CHECK ((provisioning_mode = ANY (ARRAY['manual'::text, 'push_credentials'::text, 'none'::text]))),
    CONSTRAINT marketplace_apps_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'review'::text, 'published'::text, 'disabled'::text])))
);


--
-- Name: TABLE marketplace_apps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketplace_apps IS 'Vetted app catalog for Blanc marketplace integrations';


--
-- Name: marketplace_apps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketplace_apps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketplace_apps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketplace_apps_id_seq OWNED BY public.marketplace_apps.id;


--
-- Name: marketplace_installation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_installation_events (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    installation_id bigint,
    app_id bigint,
    api_integration_id bigint,
    actor_id uuid,
    event_type text NOT NULL,
    request_id text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE marketplace_installation_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketplace_installation_events IS 'Audit log for marketplace app installation lifecycle events; never stores plaintext secrets';


--
-- Name: marketplace_installation_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketplace_installation_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketplace_installation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketplace_installation_events_id_seq OWNED BY public.marketplace_installation_events.id;


--
-- Name: marketplace_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_installations (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    app_id bigint NOT NULL,
    api_integration_id bigint,
    status text DEFAULT 'provisioning_failed'::text NOT NULL,
    installed_by uuid,
    installed_at timestamp with time zone,
    disconnected_by uuid,
    disconnected_at timestamp with time zone,
    last_provisioning_attempt_at timestamp with time zone,
    provisioning_error text,
    external_installation_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_installations_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'provisioning_failed'::text, 'disconnected'::text, 'revoked'::text])))
);


--
-- Name: TABLE marketplace_installations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketplace_installations IS 'Tenant-specific marketplace app installation state';


--
-- Name: marketplace_installations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketplace_installations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketplace_installations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketplace_installations_id_seq OWNED BY public.marketplace_installations.id;


--
-- Name: stg_jobs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stg_jobs AS
 SELECT job_id,
    lead_id,
    created_at,
    scheduled_at,
    technician_name,
    source_id,
    type AS raw_type,
    job_total_price,
    COALESCE(upper("left"((meta ->> 'PostalCode'::text), 5)), '00000'::text) AS zip,
    ((created_at)::date = (scheduled_at)::date) AS same_day_repair_flag,
        CASE
            WHEN (type ~~* '%Repair%'::text) THEN 'Repair'::text
            WHEN (type ~~* '%Service%'::text) THEN 'Diagnostic'::text
            ELSE 'Other'::text
        END AS job_category,
    ((type = ANY (ARRAY['COD Repair'::text, 'INS Repair'::text])) OR ((type = 'COD Service'::text) AND (job_total_price > (100)::numeric))) AS is_repair_canonical
   FROM public.fact_jobs j;


--
-- Name: mart_channel_mtd; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_channel_mtd AS
 SELECT ds.name AS channel_name,
    (date_trunc('month'::text, fl.created_at))::date AS month_start,
    count(DISTINCT fl.lead_id) AS total_leads,
    sum(
        CASE
            WHEN ((fl.meta ->> 'status'::text) = 'valid'::text) THEN 1
            ELSE 0
        END) AS valid_leads,
    sum(fl.cost) AS total_spend,
    count(DISTINCT fj.job_id) AS diagnostics_done,
    count(DISTINCT
        CASE
            WHEN sj.is_repair_canonical THEN fj.job_id
            ELSE NULL::character varying
        END) AS repairs_completed,
    (sum(fl.cost) / (NULLIF(count(DISTINCT
        CASE
            WHEN ((fl.meta ->> 'status'::text) = 'valid'::text) THEN fl.lead_id
            ELSE NULL::character varying
        END), 0))::numeric) AS cost_per_valid_lead,
    (sum(fl.cost) / (NULLIF(count(DISTINCT fj.job_id), 0))::numeric) AS cost_per_diagnostic,
    (sum(fl.cost) / (NULLIF(count(DISTINCT
        CASE
            WHEN sj.is_repair_canonical THEN fj.job_id
            ELSE NULL::character varying
        END), 0))::numeric) AS cost_per_repair
   FROM (((public.fact_leads fl
     LEFT JOIN public.dim_source ds ON ((fl.source_id = ds.id)))
     LEFT JOIN public.fact_jobs fj ON (((fj.lead_id)::text = (fl.lead_id)::text)))
     LEFT JOIN public.stg_jobs sj ON (((sj.job_id)::text = (fj.job_id)::text)))
  GROUP BY ds.name, ((date_trunc('month'::text, fl.created_at))::date);


--
-- Name: mart_lead_funnel_mtd; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_lead_funnel_mtd AS
 SELECT ds.name AS channel_name,
    (date_trunc('month'::text, fl.created_at))::date AS month_start,
    count(DISTINCT fl.lead_id) AS leads_total,
    count(DISTINCT fj.job_id) AS diagnostics_booked,
    count(DISTINCT
        CASE
            WHEN ((fj.meta ->> 'status'::text) = 'Cancelled'::text) THEN fj.job_id
            ELSE NULL::character varying
        END) AS diagnostics_canceled,
    count(DISTINCT
        CASE
            WHEN sj.is_repair_canonical THEN fj.job_id
            ELSE NULL::character varying
        END) AS repairs_completed
   FROM (((public.fact_leads fl
     LEFT JOIN public.dim_source ds ON ((fl.source_id = ds.id)))
     LEFT JOIN public.fact_jobs fj ON (((fj.lead_id)::text = (fl.lead_id)::text)))
     LEFT JOIN public.stg_jobs sj ON (((sj.job_id)::text = (fj.job_id)::text)))
  GROUP BY ds.name, ((date_trunc('month'::text, fl.created_at))::date);


--
-- Name: mart_profit_mtd; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_profit_mtd AS
 WITH daily_rev AS (
         SELECT (date_trunc('day'::text, fact_payments.paid_at))::date AS d,
            sum(fact_payments.amount) AS gross_revenue
           FROM public.fact_payments
          GROUP BY ((date_trunc('day'::text, fact_payments.paid_at))::date)
        ), daily_exp AS (
         SELECT fact_expense.expense_date AS d,
            sum(fact_expense.amount) AS total_expenses
           FROM public.fact_expense
          GROUP BY fact_expense.expense_date
        )
 SELECT dd.d,
    COALESCE(dr.gross_revenue, (0)::numeric) AS gross_revenue,
    COALESCE(de.total_expenses, (0)::numeric) AS total_expenses,
    (COALESCE(dr.gross_revenue, (0)::numeric) - COALESCE(de.total_expenses, (0)::numeric)) AS net_profit
   FROM ((public.dim_date dd
     LEFT JOIN daily_rev dr ON ((dr.d = dd.d)))
     LEFT JOIN daily_exp de ON ((de.d = dd.d)));


--
-- Name: mart_profit_mtd_v2; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_profit_mtd_v2 AS
 WITH month_info AS (
         SELECT (date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone))::date AS month_start,
            (((date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone) + '1 mon'::interval) - '1 day'::interval))::date AS last_day_of_month,
            EXTRACT(day FROM ((date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone) + '1 mon'::interval) - '1 day'::interval)) AS days_in_month,
            EXTRACT(day FROM CURRENT_DATE) AS current_day
        ), mtd_actuals AS (
         SELECT (date_trunc('month'::text, (mart_profit_mtd.d)::timestamp with time zone))::date AS m_start,
            COALESCE(sum(mart_profit_mtd.gross_revenue), (0)::numeric) AS mtd_revenue,
            COALESCE(sum(mart_profit_mtd.total_expenses), (0)::numeric) AS mtd_expenses,
            COALESCE(sum(mart_profit_mtd.net_profit), (0)::numeric) AS mtd_profit
           FROM public.mart_profit_mtd
          WHERE ((mart_profit_mtd.d <= CURRENT_DATE) AND (mart_profit_mtd.d >= date_trunc('month'::text, (CURRENT_DATE)::timestamp with time zone)))
          GROUP BY ((date_trunc('month'::text, (mart_profit_mtd.d)::timestamp with time zone))::date)
        ), recent_avg AS (
         SELECT COALESCE(avg(mart_profit_mtd.net_profit), (0)::numeric) AS avg_daily_profit_14d
           FROM public.mart_profit_mtd
          WHERE ((mart_profit_mtd.d > (CURRENT_DATE - '14 days'::interval)) AND (mart_profit_mtd.d <= CURRENT_DATE))
        )
 SELECT m.month_start,
    COALESCE(a.mtd_revenue, (0)::numeric) AS mtd_revenue,
    COALESCE(a.mtd_expenses, (0)::numeric) AS mtd_expenses,
    COALESCE(a.mtd_profit, (0)::numeric) AS mtd_profit,
    r.avg_daily_profit_14d,
    (COALESCE(a.mtd_profit, (0)::numeric) + (r.avg_daily_profit_14d * (m.days_in_month - m.current_day))) AS projected_profit
   FROM ((month_info m
     LEFT JOIN mtd_actuals a ON ((a.m_start = m.month_start)))
     CROSS JOIN recent_avg r);


--
-- Name: mart_tech_mtd; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_tech_mtd AS
 SELECT technician_name,
    (date_trunc('month'::text, created_at))::date AS month_start,
    count(*) AS total_jobs,
    sum(
        CASE
            WHEN is_repair_canonical THEN 1
            ELSE 0
        END) AS repairs_count,
    sum(job_total_price) AS gross_revenue,
    avg(job_total_price) AS avg_revenue_per_job,
    ((sum(
        CASE
            WHEN (same_day_repair_flag AND is_repair_canonical) THEN 1
            ELSE 0
        END))::numeric / (NULLIF(sum(
        CASE
            WHEN is_repair_canonical THEN 1
            ELSE 0
        END), 0))::numeric) AS same_day_rate
   FROM public.stg_jobs
  WHERE (technician_name IS NOT NULL)
  GROUP BY technician_name, ((date_trunc('month'::text, created_at))::date);


--
-- Name: mart_zip_mtd; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.mart_zip_mtd AS
 SELECT sj.zip,
    dz.lat,
    dz.lon,
    (date_trunc('month'::text, sj.created_at))::date AS month_start,
    count(*) AS job_count,
    sum(sj.job_total_price) AS total_revenue
   FROM (public.stg_jobs sj
     LEFT JOIN public.dim_zip dz ON (((dz.zip)::text = sj.zip)))
  GROUP BY sj.zip, dz.lat, dz.lon, ((date_trunc('month'::text, sj.created_at))::date);


--
-- Name: migration_model; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migration_model (
    id character varying(36) NOT NULL,
    version character varying(36),
    update_time bigint DEFAULT 0 NOT NULL
);


--
-- Name: monthly_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monthly_metrics (
    id integer NOT NULL,
    month date NOT NULL,
    source character varying(100),
    segment character varying(50),
    leads integer DEFAULT 0,
    units integer DEFAULT 0,
    repairs integer DEFAULT 0,
    revenue_gross numeric(10,2) DEFAULT 0,
    revenue40 numeric(10,2) DEFAULT 0,
    cost numeric(10,2) DEFAULT 0,
    profit numeric(10,2) DEFAULT 0,
    calls integer DEFAULT 0,
    google_spend numeric(10,2) DEFAULT 0,
    cpl numeric(10,2),
    conv_l_to_r numeric(5,4),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: monthly_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monthly_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monthly_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monthly_metrics_id_seq OWNED BY public.monthly_metrics.id;


--
-- Name: note_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_attachments (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id bigint NOT NULL,
    note_index integer,
    file_name character varying(255) NOT NULL,
    content_type character varying(100),
    file_size integer,
    storage_key text NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT note_attachments_entity_type_check CHECK (((entity_type)::text = ANY (ARRAY[('job'::character varying)::text, ('lead'::character varying)::text, ('contact'::character varying)::text])))
);


--
-- Name: note_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.note_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: note_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.note_attachments_id_seq OWNED BY public.note_attachments.id;


--
-- Name: offline_client_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offline_client_session (
    user_session_id character varying(36) NOT NULL,
    client_id character varying(255) NOT NULL,
    offline_flag character varying(4) NOT NULL,
    "timestamp" integer,
    data text,
    client_storage_provider character varying(36) DEFAULT 'local'::character varying NOT NULL,
    external_client_id character varying(255) DEFAULT 'local'::character varying NOT NULL,
    version integer DEFAULT 0
);


--
-- Name: offline_user_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offline_user_session (
    user_session_id character varying(36) NOT NULL,
    user_id character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    created_on integer NOT NULL,
    offline_flag character varying(4) NOT NULL,
    data text,
    last_session_refresh integer DEFAULT 0 NOT NULL,
    broker_session_id character varying(1024),
    version integer DEFAULT 0
);


--
-- Name: org; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org (
    id character varying(255) NOT NULL,
    enabled boolean NOT NULL,
    realm_id character varying(255) NOT NULL,
    group_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(4000),
    alias character varying(255) NOT NULL,
    redirect_url character varying(2048)
);


--
-- Name: org_domain; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_domain (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    verified boolean NOT NULL,
    org_id character varying(255) NOT NULL
);


--
-- Name: payment_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_receipts (
    id bigint NOT NULL,
    transaction_id bigint NOT NULL,
    receipt_number character varying(50) NOT NULL,
    sent_to_email character varying(255),
    sent_to_phone character varying(30),
    sent_via character varying(20),
    pdf_storage_key text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_receipts_sent_via_check CHECK (((sent_via)::text = ANY (ARRAY[('email'::character varying)::text, ('sms'::character varying)::text, ('portal'::character varying)::text])))
);


--
-- Name: TABLE payment_receipts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_receipts IS 'PF004: Receipt tracking for payment transactions';


--
-- Name: payment_receipts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_receipts_id_seq OWNED BY public.payment_receipts.id;


--
-- Name: payment_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_transactions (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    contact_id bigint,
    estimate_id bigint,
    invoice_id bigint,
    job_id bigint,
    transaction_type character varying(20) NOT NULL,
    payment_method character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    reference_number character varying(100),
    external_id character varying(255),
    external_source character varying(50),
    memo text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone,
    recorded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_transactions_payment_method_check CHECK (((payment_method)::text = ANY (ARRAY[('credit_card'::character varying)::text, ('ach'::character varying)::text, ('check'::character varying)::text, ('cash'::character varying)::text, ('other'::character varying)::text, ('zenbooker_sync'::character varying)::text]))),
    CONSTRAINT payment_transactions_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('refunded'::character varying)::text, ('voided'::character varying)::text]))),
    CONSTRAINT payment_transactions_transaction_type_check CHECK (((transaction_type)::text = ANY (ARRAY[('payment'::character varying)::text, ('refund'::character varying)::text, ('adjustment'::character varying)::text])))
);


--
-- Name: TABLE payment_transactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_transactions IS 'PF004: Canonical payment ledger for all payment types';


--
-- Name: payment_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_transactions_id_seq OWNED BY public.payment_transactions.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id integer NOT NULL,
    payment_id character varying(255),
    job_id character varying(255) NOT NULL,
    date date NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_type character varying(100),
    source character varying(100),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: phone_number_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_number_settings (
    id bigint NOT NULL,
    phone_number text NOT NULL,
    friendly_name text,
    routing_mode character varying(20) DEFAULT 'sip'::character varying NOT NULL,
    client_identity text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id uuid,
    group_id text
);


--
-- Name: phone_number_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phone_number_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phone_number_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phone_number_settings_id_seq OWNED BY public.phone_number_settings.id;


--
-- Name: policy_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_config (
    policy_id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    value text
);


--
-- Name: portal_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    contact_id bigint NOT NULL,
    token_hash character varying(128) NOT NULL,
    scope character varying(30) DEFAULT 'full'::character varying NOT NULL,
    document_type character varying(20),
    document_id bigint,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portal_access_tokens_scope_check CHECK (((scope)::text = ANY (ARRAY[('full'::character varying)::text, ('estimate'::character varying)::text, ('invoice'::character varying)::text, ('payment'::character varying)::text])))
);


--
-- Name: TABLE portal_access_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_access_tokens IS 'PF005: Magic link tokens for client portal access (stores hash, never raw token)';


--
-- Name: portal_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_events (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    contact_id bigint,
    event_type character varying(50) NOT NULL,
    document_type character varying(20),
    document_id bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE portal_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_events IS 'PF005: Client portal activity and interaction log';


--
-- Name: portal_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.portal_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: portal_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.portal_events_id_seq OWNED BY public.portal_events.id;


--
-- Name: portal_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_id uuid NOT NULL,
    contact_id bigint NOT NULL,
    ip_address inet,
    user_agent text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: TABLE portal_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_sessions IS 'PF005: Active client portal session tracking';


--
-- Name: protocol_mapper; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protocol_mapper (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    protocol character varying(255) NOT NULL,
    protocol_mapper_name character varying(255) NOT NULL,
    client_id character varying(36),
    client_scope_id character varying(36)
);


--
-- Name: protocol_mapper_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protocol_mapper_config (
    protocol_mapper_id character varying(36) NOT NULL,
    value text,
    name character varying(255) NOT NULL
);


--
-- Name: provider_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_connections (
    id text NOT NULL,
    tenant_id text NOT NULL,
    provider text DEFAULT 'vapi'::text NOT NULL,
    environment text DEFAULT 'prod'::text NOT NULL,
    status text DEFAULT 'connecting'::text NOT NULL,
    encrypted_credentials_json text,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    browser_name text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true
);


--
-- Name: TABLE push_subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.push_subscriptions IS 'Browser Web Push subscriptions per user/device';


--
-- Name: COLUMN push_subscriptions.endpoint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.endpoint IS 'Push service endpoint URL from PushSubscription';


--
-- Name: COLUMN push_subscriptions.p256dh; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.p256dh IS 'Client public key for payload encryption';


--
-- Name: COLUMN push_subscriptions.auth; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.auth IS 'Auth secret for payload encryption';


--
-- Name: COLUMN push_subscriptions.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.push_subscriptions.is_active IS 'False when subscription is revoked or expired (410 Gone)';


--
-- Name: quick_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quick_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    content text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rate_me_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_me_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type character varying(255) NOT NULL,
    job_id character varying(255),
    customer_id character varying(255),
    data jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: realm; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm (
    id character varying(36) NOT NULL,
    access_code_lifespan integer,
    user_action_lifespan integer,
    access_token_lifespan integer,
    account_theme character varying(255),
    admin_theme character varying(255),
    email_theme character varying(255),
    enabled boolean DEFAULT false NOT NULL,
    events_enabled boolean DEFAULT false NOT NULL,
    events_expiration bigint,
    login_theme character varying(255),
    name character varying(255),
    not_before integer,
    password_policy character varying(2550),
    registration_allowed boolean DEFAULT false NOT NULL,
    remember_me boolean DEFAULT false NOT NULL,
    reset_password_allowed boolean DEFAULT false NOT NULL,
    social boolean DEFAULT false NOT NULL,
    ssl_required character varying(255),
    sso_idle_timeout integer,
    sso_max_lifespan integer,
    update_profile_on_soc_login boolean DEFAULT false NOT NULL,
    verify_email boolean DEFAULT false NOT NULL,
    master_admin_client character varying(36),
    login_lifespan integer,
    internationalization_enabled boolean DEFAULT false NOT NULL,
    default_locale character varying(255),
    reg_email_as_username boolean DEFAULT false NOT NULL,
    admin_events_enabled boolean DEFAULT false NOT NULL,
    admin_events_details_enabled boolean DEFAULT false NOT NULL,
    edit_username_allowed boolean DEFAULT false NOT NULL,
    otp_policy_counter integer DEFAULT 0,
    otp_policy_window integer DEFAULT 1,
    otp_policy_period integer DEFAULT 30,
    otp_policy_digits integer DEFAULT 6,
    otp_policy_alg character varying(36) DEFAULT 'HmacSHA1'::character varying,
    otp_policy_type character varying(36) DEFAULT 'totp'::character varying,
    browser_flow character varying(36),
    registration_flow character varying(36),
    direct_grant_flow character varying(36),
    reset_credentials_flow character varying(36),
    client_auth_flow character varying(36),
    offline_session_idle_timeout integer DEFAULT 0,
    revoke_refresh_token boolean DEFAULT false NOT NULL,
    access_token_life_implicit integer DEFAULT 0,
    login_with_email_allowed boolean DEFAULT true NOT NULL,
    duplicate_emails_allowed boolean DEFAULT false NOT NULL,
    docker_auth_flow character varying(36),
    refresh_token_max_reuse integer DEFAULT 0,
    allow_user_managed_access boolean DEFAULT false NOT NULL,
    sso_max_lifespan_remember_me integer DEFAULT 0 NOT NULL,
    sso_idle_timeout_remember_me integer DEFAULT 0 NOT NULL,
    default_role character varying(255)
);


--
-- Name: realm_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_attribute (
    name character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL,
    value text
);


--
-- Name: realm_default_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_default_groups (
    realm_id character varying(36) NOT NULL,
    group_id character varying(36) NOT NULL
);


--
-- Name: realm_enabled_event_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_enabled_event_types (
    realm_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: realm_events_listeners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_events_listeners (
    realm_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: realm_localizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_localizations (
    realm_id character varying(255) NOT NULL,
    locale character varying(255) NOT NULL,
    texts text NOT NULL
);


--
-- Name: realm_required_credential; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_required_credential (
    type character varying(255) NOT NULL,
    form_label character varying(255),
    input boolean DEFAULT false NOT NULL,
    secret boolean DEFAULT false NOT NULL,
    realm_id character varying(36) NOT NULL
);


--
-- Name: realm_smtp_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_smtp_config (
    realm_id character varying(36) NOT NULL,
    value character varying(255),
    name character varying(255) NOT NULL
);


--
-- Name: realm_supported_locales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realm_supported_locales (
    realm_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recordings (
    id bigint NOT NULL,
    recording_sid character varying(100) NOT NULL,
    call_sid character varying(100) NOT NULL,
    status character varying(30) NOT NULL,
    recording_url text,
    duration_sec integer,
    channels smallint,
    track character varying(20),
    source character varying(50),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: TABLE recordings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recordings IS 'Записи разговоров — может быть несколько на один звонок';


--
-- Name: recordings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recordings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recordings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recordings_id_seq OWNED BY public.recordings.id;


--
-- Name: redirect_uris; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redirect_uris (
    client_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: referral_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id character varying(255) NOT NULL,
    referral_slug character varying(255) NOT NULL,
    customer_first_name character varying(255),
    customer_last_name character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: referral_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referral_link_id uuid NOT NULL,
    recipient_phone character varying(255) NOT NULL,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: required_action_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.required_action_config (
    required_action_id character varying(36) NOT NULL,
    value text,
    name character varying(255) NOT NULL
);


--
-- Name: required_action_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.required_action_provider (
    id character varying(36) NOT NULL,
    alias character varying(255),
    name character varying(255),
    realm_id character varying(36),
    enabled boolean DEFAULT false NOT NULL,
    default_action boolean DEFAULT false NOT NULL,
    provider_id character varying(255),
    priority integer
);


--
-- Name: resource_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_attribute (
    id character varying(36) DEFAULT 'sybase-needs-something-here'::character varying NOT NULL,
    name character varying(255) NOT NULL,
    value character varying(255),
    resource_id character varying(36) NOT NULL
);


--
-- Name: resource_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_policy (
    resource_id character varying(36) NOT NULL,
    policy_id character varying(36) NOT NULL
);


--
-- Name: resource_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_scope (
    resource_id character varying(36) NOT NULL,
    scope_id character varying(36) NOT NULL
);


--
-- Name: resource_server; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_server (
    id character varying(36) NOT NULL,
    allow_rs_remote_mgmt boolean DEFAULT false NOT NULL,
    policy_enforce_mode smallint NOT NULL,
    decision_strategy smallint DEFAULT 1 NOT NULL
);


--
-- Name: resource_server_perm_ticket; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_server_perm_ticket (
    id character varying(36) NOT NULL,
    owner character varying(255) NOT NULL,
    requester character varying(255) NOT NULL,
    created_timestamp bigint NOT NULL,
    granted_timestamp bigint,
    resource_id character varying(36) NOT NULL,
    scope_id character varying(36),
    resource_server_id character varying(36) NOT NULL,
    policy_id character varying(36)
);


--
-- Name: resource_server_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_server_policy (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(255),
    type character varying(255) NOT NULL,
    decision_strategy smallint,
    logic smallint,
    resource_server_id character varying(36) NOT NULL,
    owner character varying(255)
);


--
-- Name: resource_server_resource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_server_resource (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(255),
    icon_uri character varying(255),
    owner character varying(255) NOT NULL,
    resource_server_id character varying(36) NOT NULL,
    owner_managed_access boolean DEFAULT false NOT NULL,
    display_name character varying(255)
);


--
-- Name: resource_server_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_server_scope (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    icon_uri character varying(255),
    resource_server_id character varying(36) NOT NULL,
    display_name character varying(255)
);


--
-- Name: resource_uris; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_uris (
    resource_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: revoked_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revoked_token (
    id character varying(255) NOT NULL,
    expire bigint NOT NULL
);


--
-- Name: rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rewards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id character varying(255) NOT NULL,
    job_id character varying(255),
    new_job_id character varying(255),
    type character varying(50) NOT NULL,
    amount numeric(10,2) NOT NULL,
    currency character varying(3) DEFAULT 'USD'::character varying NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_reward_status CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('paid'::character varying)::text, ('cancelled'::character varying)::text]))),
    CONSTRAINT chk_reward_type CHECK (((type)::text = ANY (ARRAY[('review_perk'::character varying)::text, ('share_perk'::character varying)::text, ('referral_payout'::character varying)::text])))
);


--
-- Name: role_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_attribute (
    id character varying(36) NOT NULL,
    role_id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    value character varying(255)
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: scope_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_mapping (
    client_id character varying(36) NOT NULL,
    role_id character varying(36) NOT NULL
);


--
-- Name: scope_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scope_policy (
    scope_id character varying(36) NOT NULL,
    policy_id character varying(36) NOT NULL
);


--
-- Name: service_territories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_territories (
    company_id uuid NOT NULL,
    zip character varying(10) NOT NULL,
    area text DEFAULT ''::text NOT NULL,
    city text,
    state text,
    county text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: servicedirect_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servicedirect_leads (
    id integer NOT NULL,
    lead_id character varying(255) NOT NULL,
    date date NOT NULL,
    "time" timestamp with time zone,
    campaign character varying(255),
    lead_name character varying(255),
    lead_phone character varying(50),
    call_duration character varying(50),
    lead_email character varying(255),
    form_submission text,
    service_category character varying(255),
    campaign_type character varying(255),
    billable character varying(50),
    lead_status character varying(255),
    job_status character varying(255),
    need_follow_up character varying(50),
    call_answered character varying(50),
    booked_appointment character varying(50),
    lost_reasons text,
    under_review character varying(50),
    revenue numeric(10,2),
    cost numeric(10,2),
    address text,
    unit character varying(50),
    city character varying(100),
    state character varying(50),
    zip_code character varying(20),
    raw_data jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: servicedirect_leads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.servicedirect_leads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: servicedirect_leads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.servicedirect_leads_id_seq OWNED BY public.servicedirect_leads.id;


--
-- Name: sms_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    twilio_conversation_sid text,
    service_sid text,
    channel_type text DEFAULT 'sms'::text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    customer_e164 text,
    proxy_e164 text,
    friendly_name text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'twilio'::text NOT NULL,
    first_message_at timestamp with time zone,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_message_direction text,
    closed_at timestamp with time zone,
    company_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    has_unread boolean DEFAULT false NOT NULL,
    last_read_at timestamp with time zone,
    last_incoming_at timestamp with time zone,
    customer_digits text
);


--
-- Name: sms_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_events (
    id bigint NOT NULL,
    provider text DEFAULT 'twilio_conversations'::text NOT NULL,
    event_type text NOT NULL,
    idempotency_key text NOT NULL,
    twilio_request_sid text,
    conversation_sid text,
    message_sid text,
    participant_sid text,
    webhook_url text,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    processing_status text DEFAULT 'received'::text NOT NULL,
    processing_error text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: sms_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sms_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sms_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sms_events_id_seq OWNED BY public.sms_events.id;


--
-- Name: sms_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    twilio_media_sid text,
    category text DEFAULT 'media'::text NOT NULL,
    filename text,
    content_type text,
    size_bytes bigint,
    preview_kind text,
    storage_provider text DEFAULT 'twilio'::text NOT NULL,
    temporary_url text,
    temporary_url_expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    twilio_message_sid text,
    conversation_id uuid NOT NULL,
    conversation_sid text,
    author text,
    author_type text DEFAULT 'external'::text NOT NULL,
    direction text NOT NULL,
    transport text DEFAULT 'sms'::text NOT NULL,
    body text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    delivery_status text,
    error_code integer,
    error_message text,
    index_in_conversation bigint,
    date_created_remote timestamp with time zone,
    date_updated_remote timestamp with time zone,
    date_sent_remote timestamp with time zone,
    company_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    job_name text NOT NULL,
    cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.targets (
    id integer NOT NULL,
    month date NOT NULL,
    source character varying(100),
    segment character varying(50),
    metric_type character varying(50) NOT NULL,
    target_value numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: targets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: targets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.targets_id_seq OWNED BY public.targets.id;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id bigint NOT NULL,
    company_id uuid,
    thread_id bigint NOT NULL,
    subject_type text DEFAULT 'contact'::text NOT NULL,
    subject_id bigint,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'p2'::text NOT NULL,
    due_at timestamp with time zone,
    owner_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text DEFAULT 'user'::text NOT NULL,
    completed_at timestamp with time zone,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    assigned_provider_id uuid,
    show_on_schedule boolean DEFAULT false NOT NULL,
    CONSTRAINT tasks_created_by_check CHECK ((created_by = ANY (ARRAY['system'::text, 'user'::text]))),
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['p1'::text, 'p2'::text, 'p3'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])))
);


--
-- Name: TABLE tasks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tasks IS 'Dispatcher tasks linked to Pulse timeline threads';


--
-- Name: COLUMN tasks.start_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.start_at IS 'PF001: Schedule start time (nullable for non-scheduled tasks)';


--
-- Name: COLUMN tasks.end_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.end_at IS 'PF001: Schedule end time';


--
-- Name: COLUMN tasks.assigned_provider_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.assigned_provider_id IS 'PF001: Assigned field provider for dispatch';


--
-- Name: COLUMN tasks.show_on_schedule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.show_on_schedule IS 'PF001: Whether this task appears on the schedule view';


--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: timelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timelines (
    id bigint NOT NULL,
    phone_e164 text,
    contact_id bigint,
    company_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sms_last_at timestamp with time zone,
    has_unread boolean DEFAULT false NOT NULL,
    last_read_at timestamp with time zone,
    is_action_required boolean DEFAULT false NOT NULL,
    action_required_reason text,
    action_required_set_at timestamp with time zone,
    action_required_set_by text,
    snoozed_until timestamp with time zone,
    owner_user_id uuid,
    CONSTRAINT chk_timelines_identity CHECK (((contact_id IS NOT NULL) OR (phone_e164 IS NOT NULL)))
);


--
-- Name: COLUMN timelines.is_action_required; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.timelines.is_action_required IS 'Whether this thread requires dispatcher action';


--
-- Name: COLUMN timelines.action_required_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.timelines.action_required_reason IS 'Why action is required: new_message, manual, etc.';


--
-- Name: COLUMN timelines.snoozed_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.timelines.snoozed_until IS 'If set, thread is hidden from AR queue until this time';


--
-- Name: COLUMN timelines.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.timelines.owner_user_id IS 'Assigned owner (dispatcher) for this thread';


--
-- Name: timelines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.timelines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: timelines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.timelines_id_seq OWNED BY public.timelines.id;


--
-- Name: transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcripts (
    id bigint NOT NULL,
    transcription_sid character varying(100),
    call_sid character varying(100),
    recording_sid character varying(100),
    mode character varying(20) DEFAULT 'post-call'::character varying NOT NULL,
    status character varying(30) NOT NULL,
    language_code character varying(20),
    confidence numeric(5,4),
    text text,
    is_final boolean DEFAULT true NOT NULL,
    sequence_no bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    company_id uuid NOT NULL
);


--
-- Name: TABLE transcripts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transcripts IS 'Транскрипции голосовых записей — post-call или realtime';


--
-- Name: transcripts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transcripts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transcripts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transcripts_id_seq OWNED BY public.transcripts.id;


--
-- Name: user_attribute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_attribute (
    name character varying(255) NOT NULL,
    value character varying(255),
    user_id character varying(36) NOT NULL,
    id character varying(36) DEFAULT 'sybase-needs-something-here'::character varying NOT NULL,
    long_value_hash bytea,
    long_value_hash_lower_case bytea,
    long_value text
);


--
-- Name: user_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_consent (
    id character varying(36) NOT NULL,
    client_id character varying(255),
    user_id character varying(36) NOT NULL,
    created_date bigint,
    last_updated_date bigint,
    client_storage_provider character varying(36),
    external_client_id character varying(255)
);


--
-- Name: user_consent_client_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_consent_client_scope (
    user_consent_id character varying(36) NOT NULL,
    scope_id character varying(36) NOT NULL
);


--
-- Name: user_entity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_entity (
    id character varying(36) NOT NULL,
    email character varying(255),
    email_constraint character varying(255),
    email_verified boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    federation_link character varying(255),
    first_name character varying(255),
    last_name character varying(255),
    realm_id character varying(255),
    username character varying(255),
    created_timestamp bigint,
    service_account_client_link character varying(255),
    not_before integer DEFAULT 0 NOT NULL
);


--
-- Name: user_federation_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_federation_config (
    user_federation_provider_id character varying(36) NOT NULL,
    value character varying(255),
    name character varying(255) NOT NULL
);


--
-- Name: user_federation_mapper; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_federation_mapper (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    federation_provider_id character varying(36) NOT NULL,
    federation_mapper_type character varying(255) NOT NULL,
    realm_id character varying(36) NOT NULL
);


--
-- Name: user_federation_mapper_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_federation_mapper_config (
    user_federation_mapper_id character varying(36) NOT NULL,
    value character varying(255),
    name character varying(255) NOT NULL
);


--
-- Name: user_federation_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_federation_provider (
    id character varying(36) NOT NULL,
    changed_sync_period integer,
    display_name character varying(255),
    full_sync_period integer,
    last_sync integer,
    priority integer,
    provider_name character varying(255),
    realm_id character varying(36)
);


--
-- Name: user_group_hours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_hours (
    id bigint NOT NULL,
    group_id text NOT NULL,
    day_of_week text NOT NULL,
    is_open boolean DEFAULT true NOT NULL,
    open_time text,
    close_time text
);


--
-- Name: user_group_hours_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_group_hours_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_group_hours_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_group_hours_id_seq OWNED BY public.user_group_hours.id;


--
-- Name: user_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_members (
    id bigint NOT NULL,
    group_id text NOT NULL,
    user_id text NOT NULL,
    priority integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_group_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_group_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_group_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_group_members_id_seq OWNED BY public.user_group_members.id;


--
-- Name: user_group_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_membership (
    group_id character varying(36) NOT NULL,
    user_id character varying(36) NOT NULL,
    membership_type character varying(255) NOT NULL
);


--
-- Name: user_group_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_numbers (
    id bigint NOT NULL,
    group_id text NOT NULL,
    phone_number text NOT NULL,
    friendly_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_group_numbers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_group_numbers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_group_numbers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_group_numbers_id_seq OWNED BY public.user_group_numbers.id;


--
-- Name: user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_groups (
    id text NOT NULL,
    company_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text,
    strategy text DEFAULT 'Simultaneous'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_required_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_required_action (
    user_id character varying(36) NOT NULL,
    required_action character varying(255) DEFAULT ' '::character varying NOT NULL
);


--
-- Name: user_role_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role_mapping (
    role_id character varying(255) NOT NULL,
    user_id character varying(36) NOT NULL
);


--
-- Name: username_login_failure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.username_login_failure (
    realm_id character varying(36) NOT NULL,
    username character varying(255) NOT NULL,
    failed_login_not_before integer,
    last_failure bigint,
    last_ip_failure character varying(255),
    num_failures integer
);


--
-- Name: vapi_assistant_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vapi_assistant_profiles (
    id text NOT NULL,
    tenant_id text NOT NULL,
    provider_connection_id text NOT NULL,
    slug text NOT NULL,
    purpose text,
    base_config_json text,
    vapi_assistant_id text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vapi_tenant_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vapi_tenant_resources (
    id text NOT NULL,
    tenant_id text NOT NULL,
    provider_connection_id text NOT NULL,
    environment text DEFAULT 'prod'::text NOT NULL,
    vapi_phone_number_id text,
    sip_uri text,
    server_url text,
    assistant_request_secret text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vw_job_metrics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_job_metrics AS
 SELECT j.job_id,
    j.source_id,
    (date_trunc('day'::text, j.created_at))::date AS d,
    j.type,
    COALESCE(p.total_amount, (0)::numeric) AS gross_revenue,
    (COALESCE(p.total_amount, (0)::numeric) * 0.40) AS net_revenue,
    (j.type = ANY (ARRAY['COD Service'::text, 'INS Service'::text])) AS is_unit,
    ((j.type = ANY (ARRAY['COD Repair'::text, 'INS Repair'::text])) OR ((j.type = 'COD Service'::text) AND (COALESCE(p.total_amount, (0)::numeric) > (100)::numeric))) AS is_repair
   FROM (public.fact_jobs j
     LEFT JOIN ( SELECT fact_payments.job_id,
            sum(fact_payments.amount) AS total_amount
           FROM public.fact_payments
          GROUP BY fact_payments.job_id) p ON (((p.job_id)::text = (j.job_id)::text)));


--
-- Name: vw_daily_metrics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_daily_metrics AS
 SELECT dd.d,
    s.code AS source,
        CASE
            WHEN (m.type ~~ '%COD%'::text) THEN 'COD'::text
            WHEN (m.type ~~ '%INS%'::text) THEN 'INS'::text
            ELSE 'OTHER'::text
        END AS segment,
    count(DISTINCT l.lead_id) AS leads,
    sum(
        CASE
            WHEN m.is_unit THEN 1
            ELSE 0
        END) AS units,
    sum(
        CASE
            WHEN m.is_repair THEN 1
            ELSE 0
        END) AS repairs,
        CASE
            WHEN (count(DISTINCT l.lead_id) > 0) THEN ((sum(
            CASE
                WHEN m.is_unit THEN 1
                ELSE 0
            END))::numeric / (count(DISTINCT l.lead_id))::numeric)
            ELSE (0)::numeric
        END AS conv_l_u,
        CASE
            WHEN (count(DISTINCT l.lead_id) > 0) THEN ((sum(
            CASE
                WHEN m.is_repair THEN 1
                ELSE 0
            END))::numeric / (count(DISTINCT l.lead_id))::numeric)
            ELSE (0)::numeric
        END AS conv_l_r,
        CASE
            WHEN (sum(
            CASE
                WHEN m.is_unit THEN 1
                ELSE 0
            END) > 0) THEN ((sum(
            CASE
                WHEN m.is_repair THEN 1
                ELSE 0
            END))::numeric / (sum(
            CASE
                WHEN m.is_unit THEN 1
                ELSE 0
            END))::numeric)
            ELSE (0)::numeric
        END AS conv_u_r,
    sum(m.net_revenue) AS net_revenue,
    sum(l.cost) AS total_cost,
        CASE
            WHEN (count(DISTINCT l.lead_id) > 0) THEN (sum(l.cost) / (count(DISTINCT l.lead_id))::numeric)
            ELSE (0)::numeric
        END AS cpl,
        CASE
            WHEN (sum(
            CASE
                WHEN m.is_unit THEN 1
                ELSE 0
            END) > 0) THEN (sum(l.cost) / (sum(
            CASE
                WHEN m.is_unit THEN 1
                ELSE 0
            END))::numeric)
            ELSE (0)::numeric
        END AS cpu
   FROM ((((public.dim_date dd
     LEFT JOIN public.fact_leads l ON (((date_trunc('day'::text, l.created_at))::date = dd.d)))
     LEFT JOIN public.fact_jobs j ON (((j.lead_id)::text = (l.lead_id)::text)))
     LEFT JOIN public.vw_job_metrics m ON (((m.job_id)::text = (j.job_id)::text)))
     LEFT JOIN public.dim_source s ON ((s.id = COALESCE(j.source_id, l.source_id))))
  GROUP BY dd.d, s.code,
        CASE
            WHEN (m.type ~~ '%COD%'::text) THEN 'COD'::text
            WHEN (m.type ~~ '%INS%'::text) THEN 'INS'::text
            ELSE 'OTHER'::text
        END;


--
-- Name: vw_monthly_metrics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_monthly_metrics AS
 SELECT (date_trunc('month'::text, (d)::timestamp with time zone))::date AS month_start,
    source,
    segment,
    sum(leads) AS leads,
    sum(units) AS units,
    sum(repairs) AS repairs,
    sum(net_revenue) AS net_revenue,
    sum(total_cost) AS cost,
    (sum(units) / NULLIF(sum(leads), (0)::numeric)) AS conv_l_u,
    (sum(repairs) / NULLIF(sum(leads), (0)::numeric)) AS conv_l_r,
    (sum(repairs) / NULLIF(sum(units), (0)::numeric)) AS conv_u_r,
    (sum(net_revenue) / NULLIF(sum(leads), (0)::numeric)) AS rev_per_lead,
    (sum(net_revenue) / NULLIF(sum(units), (0)::numeric)) AS rev_per_unit,
    (sum(net_revenue) / NULLIF(sum(repairs), (0)::numeric)) AS rev_per_repair,
    (sum(total_cost) / NULLIF(sum(leads), (0)::numeric)) AS cpl,
    (sum(total_cost) / NULLIF(sum(units), (0)::numeric)) AS cpu
   FROM public.vw_daily_metrics
  GROUP BY (date_trunc('month'::text, (d)::timestamp with time zone)), source, segment;


--
-- Name: web_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_origins (
    client_id character varying(36) NOT NULL,
    value character varying(255) NOT NULL
);


--
-- Name: webhook_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_inbox (
    id bigint NOT NULL,
    provider text DEFAULT 'twilio'::text NOT NULL,
    event_key text NOT NULL,
    source character varying(30) NOT NULL,
    event_type character varying(50) NOT NULL,
    event_time timestamp with time zone,
    call_sid character varying(100),
    recording_sid character varying(100),
    transcription_sid character varying(100),
    payload jsonb NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'received'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_text text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    company_id uuid NOT NULL
);


--
-- Name: TABLE webhook_inbox; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.webhook_inbox IS 'Дедупликация и retry вебхуков — event_key обеспечивает idempotency';


--
-- Name: webhook_inbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.webhook_inbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: webhook_inbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.webhook_inbox_id_seq OWNED BY public.webhook_inbox.id;


--
-- Name: zb_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zb_payments (
    id bigint NOT NULL,
    company_id uuid NOT NULL,
    transaction_id text NOT NULL,
    invoice_id text,
    job_id text,
    job_number text DEFAULT '—'::text,
    client text DEFAULT '—'::text,
    job_type text DEFAULT '—'::text,
    status text DEFAULT '—'::text,
    payment_methods text DEFAULT ''::text,
    display_payment_method text DEFAULT ''::text,
    amount_paid numeric(12,2) DEFAULT 0,
    tags text DEFAULT ''::text,
    payment_date timestamp with time zone,
    source text DEFAULT ''::text,
    tech text DEFAULT '—'::text,
    transaction_status text DEFAULT ''::text,
    missing_job_link boolean DEFAULT false,
    invoice_status text,
    invoice_total numeric(12,2),
    invoice_amount_paid numeric(12,2),
    invoice_amount_due numeric(12,2),
    invoice_paid_in_full boolean DEFAULT false,
    job_detail jsonb DEFAULT 'null'::jsonb,
    invoice_detail jsonb DEFAULT 'null'::jsonb,
    attachments jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    zb_raw_transaction jsonb DEFAULT '{}'::jsonb,
    zb_raw_invoice jsonb DEFAULT 'null'::jsonb,
    zb_raw_job jsonb DEFAULT 'null'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    check_deposited boolean DEFAULT false,
    custom_fields text DEFAULT ''::text
);


--
-- Name: TABLE zb_payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.zb_payments IS 'Local cache of Zenbooker transactions with pre-assembled row data';


--
-- Name: zb_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.zb_payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: zb_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.zb_payments_id_seq OWNED BY public.zb_payments.id;


--
-- Name: api_integrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations ALTER COLUMN id SET DEFAULT nextval('public.api_integrations_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: call_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events ALTER COLUMN id SET DEFAULT nextval('public.call_events_id_seq'::regclass);


--
-- Name: calls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls ALTER COLUMN id SET DEFAULT nextval('public.calls_id_seq'::regclass);


--
-- Name: contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts ALTER COLUMN id SET DEFAULT nextval('public.contacts_id_seq'::regclass);


--
-- Name: daily_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_metrics ALTER COLUMN id SET DEFAULT nextval('public.daily_metrics_id_seq'::regclass);


--
-- Name: dim_source id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dim_source ALTER COLUMN id SET DEFAULT nextval('public.dim_source_id_seq'::regclass);


--
-- Name: dispatch_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_settings ALTER COLUMN id SET DEFAULT nextval('public.dispatch_settings_id_seq'::regclass);


--
-- Name: document_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments ALTER COLUMN id SET DEFAULT nextval('public.document_attachments_id_seq'::regclass);


--
-- Name: document_deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_deliveries ALTER COLUMN id SET DEFAULT nextval('public.document_deliveries_id_seq'::regclass);


--
-- Name: domain_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events ALTER COLUMN id SET DEFAULT nextval('public.domain_events_id_seq'::regclass);


--
-- Name: elocals_leads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.elocals_leads ALTER COLUMN id SET DEFAULT nextval('public.elocals_leads_id_seq'::regclass);


--
-- Name: email_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_attachments ALTER COLUMN id SET DEFAULT nextval('public.email_attachments_id_seq'::regclass);


--
-- Name: email_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages ALTER COLUMN id SET DEFAULT nextval('public.email_messages_id_seq'::regclass);


--
-- Name: email_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads ALTER COLUMN id SET DEFAULT nextval('public.email_threads_id_seq'::regclass);


--
-- Name: estimate_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_events ALTER COLUMN id SET DEFAULT nextval('public.estimate_events_id_seq'::regclass);


--
-- Name: estimate_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_items ALTER COLUMN id SET DEFAULT nextval('public.estimate_items_id_seq'::regclass);


--
-- Name: estimate_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_revisions ALTER COLUMN id SET DEFAULT nextval('public.estimate_revisions_id_seq'::regclass);


--
-- Name: estimates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates ALTER COLUMN id SET DEFAULT nextval('public.estimates_id_seq'::regclass);


--
-- Name: fact_expense expense_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_expense ALTER COLUMN expense_id SET DEFAULT nextval('public.fact_expense_expense_id_seq'::regclass);


--
-- Name: fact_parts part_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_parts ALTER COLUMN part_id SET DEFAULT nextval('public.fact_parts_part_id_seq'::regclass);


--
-- Name: google_spend id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_spend ALTER COLUMN id SET DEFAULT nextval('public.google_spend_id_seq'::regclass);


--
-- Name: invoice_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_events ALTER COLUMN id SET DEFAULT nextval('public.invoice_events_id_seq'::regclass);


--
-- Name: invoice_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_items_id_seq'::regclass);


--
-- Name: invoice_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_revisions ALTER COLUMN id SET DEFAULT nextval('public.invoice_revisions_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: job_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tags ALTER COLUMN id SET DEFAULT nextval('public.job_tags_id_seq'::regclass);


--
-- Name: jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);


--
-- Name: kpi_targets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets ALTER COLUMN id SET DEFAULT nextval('public.kpi_targets_id_seq'::regclass);


--
-- Name: lead_custom_fields id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_custom_fields ALTER COLUMN id SET DEFAULT nextval('public.lead_custom_fields_id_seq'::regclass);


--
-- Name: lead_job_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_job_types ALTER COLUMN id SET DEFAULT nextval('public.lead_job_types_id_seq'::regclass);


--
-- Name: lead_team_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_team_assignments ALTER COLUMN id SET DEFAULT nextval('public.lead_team_assignments_id_seq'::regclass);


--
-- Name: leads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads ALTER COLUMN id SET DEFAULT nextval('public.leads_id_seq'::regclass);


--
-- Name: leads serial_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads ALTER COLUMN serial_id SET DEFAULT nextval('public.leads_serial_id_seq'::regclass);


--
-- Name: marketplace_apps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_apps ALTER COLUMN id SET DEFAULT nextval('public.marketplace_apps_id_seq'::regclass);


--
-- Name: marketplace_installation_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events ALTER COLUMN id SET DEFAULT nextval('public.marketplace_installation_events_id_seq'::regclass);


--
-- Name: marketplace_installations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations ALTER COLUMN id SET DEFAULT nextval('public.marketplace_installations_id_seq'::regclass);


--
-- Name: monthly_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_metrics ALTER COLUMN id SET DEFAULT nextval('public.monthly_metrics_id_seq'::regclass);


--
-- Name: note_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_attachments ALTER COLUMN id SET DEFAULT nextval('public.note_attachments_id_seq'::regclass);


--
-- Name: payment_receipts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_receipts ALTER COLUMN id SET DEFAULT nextval('public.payment_receipts_id_seq'::regclass);


--
-- Name: payment_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions ALTER COLUMN id SET DEFAULT nextval('public.payment_transactions_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: phone_number_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_number_settings ALTER COLUMN id SET DEFAULT nextval('public.phone_number_settings_id_seq'::regclass);


--
-- Name: portal_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events ALTER COLUMN id SET DEFAULT nextval('public.portal_events_id_seq'::regclass);


--
-- Name: recordings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings ALTER COLUMN id SET DEFAULT nextval('public.recordings_id_seq'::regclass);


--
-- Name: servicedirect_leads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servicedirect_leads ALTER COLUMN id SET DEFAULT nextval('public.servicedirect_leads_id_seq'::regclass);


--
-- Name: sms_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_events ALTER COLUMN id SET DEFAULT nextval('public.sms_events_id_seq'::regclass);


--
-- Name: targets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets ALTER COLUMN id SET DEFAULT nextval('public.targets_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: timelines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timelines ALTER COLUMN id SET DEFAULT nextval('public.timelines_id_seq'::regclass);


--
-- Name: transcripts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts ALTER COLUMN id SET DEFAULT nextval('public.transcripts_id_seq'::regclass);


--
-- Name: user_group_hours id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_hours ALTER COLUMN id SET DEFAULT nextval('public.user_group_hours_id_seq'::regclass);


--
-- Name: user_group_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members ALTER COLUMN id SET DEFAULT nextval('public.user_group_members_id_seq'::regclass);


--
-- Name: user_group_numbers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_numbers ALTER COLUMN id SET DEFAULT nextval('public.user_group_numbers_id_seq'::regclass);


--
-- Name: webhook_inbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox ALTER COLUMN id SET DEFAULT nextval('public.webhook_inbox_id_seq'::regclass);


--
-- Name: zb_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zb_payments ALTER COLUMN id SET DEFAULT nextval('public.zb_payments_id_seq'::regclass);


--
-- Name: username_login_failure CONSTRAINT_17-2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.username_login_failure
    ADD CONSTRAINT "CONSTRAINT_17-2" PRIMARY KEY (realm_id, username);


--
-- Name: org_domain ORG_DOMAIN_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_domain
    ADD CONSTRAINT "ORG_DOMAIN_pkey" PRIMARY KEY (id, name);


--
-- Name: org ORG_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT "ORG_pkey" PRIMARY KEY (id);


--
-- Name: keycloak_role UK_J3RWUVD56ONTGSUHOGM184WW2-2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keycloak_role
    ADD CONSTRAINT "UK_J3RWUVD56ONTGSUHOGM184WW2-2" UNIQUE (name, client_realm_constraint);


--
-- Name: agent_presence agent_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_presence
    ADD CONSTRAINT agent_presence_pkey PRIMARY KEY (company_id, user_id);


--
-- Name: api_integrations api_integrations_key_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations
    ADD CONSTRAINT api_integrations_key_id_key UNIQUE (key_id);


--
-- Name: api_integrations api_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations
    ADD CONSTRAINT api_integrations_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: client_auth_flow_bindings c_cli_flow_bind; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_auth_flow_bindings
    ADD CONSTRAINT c_cli_flow_bind PRIMARY KEY (client_id, binding_name);


--
-- Name: client_scope_client c_cli_scope_bind; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope_client
    ADD CONSTRAINT c_cli_scope_bind PRIMARY KEY (client_id, scope_id);


--
-- Name: call_ai_runs call_ai_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_ai_runs
    ADD CONSTRAINT call_ai_runs_pkey PRIMARY KEY (id);


--
-- Name: call_events call_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_pkey PRIMARY KEY (id);


--
-- Name: call_flow_executions call_flow_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_flow_executions
    ADD CONSTRAINT call_flow_executions_pkey PRIMARY KEY (id);


--
-- Name: call_flow_node_configs call_flow_node_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_flow_node_configs
    ADD CONSTRAINT call_flow_node_configs_pkey PRIMARY KEY (id);


--
-- Name: call_flows call_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_flows
    ADD CONSTRAINT call_flows_pkey PRIMARY KEY (id);


--
-- Name: calls calls_call_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_call_sid_key UNIQUE (call_sid);


--
-- Name: calls calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_pkey PRIMARY KEY (id);


--
-- Name: client_initial_access cnstr_client_init_acc_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_initial_access
    ADD CONSTRAINT cnstr_client_init_acc_pk PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_key UNIQUE (slug);


--
-- Name: company_invitations company_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invitations
    ADD CONSTRAINT company_invitations_pkey PRIMARY KEY (id);


--
-- Name: company_membership_permission_overrides company_membership_permission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_permission_overrides
    ADD CONSTRAINT company_membership_permission_overrides_pkey PRIMARY KEY (id);


--
-- Name: company_membership_scope_overrides company_membership_scope_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_scope_overrides
    ADD CONSTRAINT company_membership_scope_overrides_pkey PRIMARY KEY (id);


--
-- Name: company_memberships company_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_pkey PRIMARY KEY (id);


--
-- Name: company_role_configs company_role_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_configs
    ADD CONSTRAINT company_role_configs_pkey PRIMARY KEY (id);


--
-- Name: company_role_permissions company_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_permissions
    ADD CONSTRAINT company_role_permissions_pkey PRIMARY KEY (id);


--
-- Name: company_role_scopes company_role_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_scopes
    ADD CONSTRAINT company_role_scopes_pkey PRIMARY KEY (id);


--
-- Name: company_settings company_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_settings
    ADD CONSTRAINT company_settings_pkey PRIMARY KEY (company_id, setting_key);


--
-- Name: company_user_profiles company_user_profiles_membership_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_profiles
    ADD CONSTRAINT company_user_profiles_membership_id_key UNIQUE (membership_id);


--
-- Name: company_user_profiles company_user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_profiles
    ADD CONSTRAINT company_user_profiles_pkey PRIMARY KEY (id);


--
-- Name: company_user_service_areas company_user_service_areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_service_areas
    ADD CONSTRAINT company_user_service_areas_pkey PRIMARY KEY (id);


--
-- Name: company_user_skills company_user_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_skills
    ADD CONSTRAINT company_user_skills_pkey PRIMARY KEY (id);


--
-- Name: realm_default_groups con_group_id_def_groups; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_default_groups
    ADD CONSTRAINT con_group_id_def_groups UNIQUE (group_id);


--
-- Name: broker_link constr_broker_link_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broker_link
    ADD CONSTRAINT constr_broker_link_pk PRIMARY KEY (identity_provider, user_id);


--
-- Name: component_config constr_component_config_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_config
    ADD CONSTRAINT constr_component_config_pk PRIMARY KEY (id);


--
-- Name: component constr_component_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component
    ADD CONSTRAINT constr_component_pk PRIMARY KEY (id);


--
-- Name: fed_user_required_action constr_fed_required_action; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_required_action
    ADD CONSTRAINT constr_fed_required_action PRIMARY KEY (required_action, user_id);


--
-- Name: fed_user_attribute constr_fed_user_attr_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_attribute
    ADD CONSTRAINT constr_fed_user_attr_pk PRIMARY KEY (id);


--
-- Name: fed_user_consent constr_fed_user_consent_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_consent
    ADD CONSTRAINT constr_fed_user_consent_pk PRIMARY KEY (id);


--
-- Name: fed_user_credential constr_fed_user_cred_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_credential
    ADD CONSTRAINT constr_fed_user_cred_pk PRIMARY KEY (id);


--
-- Name: fed_user_group_membership constr_fed_user_group; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_group_membership
    ADD CONSTRAINT constr_fed_user_group PRIMARY KEY (group_id, user_id);


--
-- Name: fed_user_role_mapping constr_fed_user_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_role_mapping
    ADD CONSTRAINT constr_fed_user_role PRIMARY KEY (role_id, user_id);


--
-- Name: federated_user constr_federated_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_user
    ADD CONSTRAINT constr_federated_user PRIMARY KEY (id);


--
-- Name: realm_default_groups constr_realm_default_groups; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_default_groups
    ADD CONSTRAINT constr_realm_default_groups PRIMARY KEY (realm_id, group_id);


--
-- Name: realm_enabled_event_types constr_realm_enabl_event_types; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_enabled_event_types
    ADD CONSTRAINT constr_realm_enabl_event_types PRIMARY KEY (realm_id, value);


--
-- Name: realm_events_listeners constr_realm_events_listeners; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_events_listeners
    ADD CONSTRAINT constr_realm_events_listeners PRIMARY KEY (realm_id, value);


--
-- Name: realm_supported_locales constr_realm_supported_locales; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_supported_locales
    ADD CONSTRAINT constr_realm_supported_locales PRIMARY KEY (realm_id, value);


--
-- Name: identity_provider constraint_2b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider
    ADD CONSTRAINT constraint_2b PRIMARY KEY (internal_id);


--
-- Name: client_attributes constraint_3c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_attributes
    ADD CONSTRAINT constraint_3c PRIMARY KEY (client_id, name);


--
-- Name: event_entity constraint_4; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_entity
    ADD CONSTRAINT constraint_4 PRIMARY KEY (id);


--
-- Name: federated_identity constraint_40; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_identity
    ADD CONSTRAINT constraint_40 PRIMARY KEY (identity_provider, user_id);


--
-- Name: realm constraint_4a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm
    ADD CONSTRAINT constraint_4a PRIMARY KEY (id);


--
-- Name: user_federation_provider constraint_5c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_provider
    ADD CONSTRAINT constraint_5c PRIMARY KEY (id);


--
-- Name: client constraint_7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT constraint_7 PRIMARY KEY (id);


--
-- Name: scope_mapping constraint_81; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mapping
    ADD CONSTRAINT constraint_81 PRIMARY KEY (client_id, role_id);


--
-- Name: client_node_registrations constraint_84; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_node_registrations
    ADD CONSTRAINT constraint_84 PRIMARY KEY (client_id, name);


--
-- Name: realm_attribute constraint_9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_attribute
    ADD CONSTRAINT constraint_9 PRIMARY KEY (name, realm_id);


--
-- Name: realm_required_credential constraint_92; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_required_credential
    ADD CONSTRAINT constraint_92 PRIMARY KEY (realm_id, type);


--
-- Name: keycloak_role constraint_a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keycloak_role
    ADD CONSTRAINT constraint_a PRIMARY KEY (id);


--
-- Name: admin_event_entity constraint_admin_event_entity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_event_entity
    ADD CONSTRAINT constraint_admin_event_entity PRIMARY KEY (id);


--
-- Name: authenticator_config_entry constraint_auth_cfg_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authenticator_config_entry
    ADD CONSTRAINT constraint_auth_cfg_pk PRIMARY KEY (authenticator_id, name);


--
-- Name: authentication_execution constraint_auth_exec_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication_execution
    ADD CONSTRAINT constraint_auth_exec_pk PRIMARY KEY (id);


--
-- Name: authentication_flow constraint_auth_flow_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication_flow
    ADD CONSTRAINT constraint_auth_flow_pk PRIMARY KEY (id);


--
-- Name: authenticator_config constraint_auth_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authenticator_config
    ADD CONSTRAINT constraint_auth_pk PRIMARY KEY (id);


--
-- Name: user_role_mapping constraint_c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_mapping
    ADD CONSTRAINT constraint_c PRIMARY KEY (role_id, user_id);


--
-- Name: composite_role constraint_composite_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.composite_role
    ADD CONSTRAINT constraint_composite_role PRIMARY KEY (composite, child_role);


--
-- Name: identity_provider_config constraint_d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider_config
    ADD CONSTRAINT constraint_d PRIMARY KEY (identity_provider_id, name);


--
-- Name: policy_config constraint_dpc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_config
    ADD CONSTRAINT constraint_dpc PRIMARY KEY (policy_id, name);


--
-- Name: realm_smtp_config constraint_e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_smtp_config
    ADD CONSTRAINT constraint_e PRIMARY KEY (realm_id, name);


--
-- Name: credential constraint_f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential
    ADD CONSTRAINT constraint_f PRIMARY KEY (id);


--
-- Name: user_federation_config constraint_f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_config
    ADD CONSTRAINT constraint_f9 PRIMARY KEY (user_federation_provider_id, name);


--
-- Name: resource_server_perm_ticket constraint_fapmt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT constraint_fapmt PRIMARY KEY (id);


--
-- Name: resource_server_resource constraint_farsr; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_resource
    ADD CONSTRAINT constraint_farsr PRIMARY KEY (id);


--
-- Name: resource_server_policy constraint_farsrp; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_policy
    ADD CONSTRAINT constraint_farsrp PRIMARY KEY (id);


--
-- Name: associated_policy constraint_farsrpap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.associated_policy
    ADD CONSTRAINT constraint_farsrpap PRIMARY KEY (policy_id, associated_policy_id);


--
-- Name: resource_policy constraint_farsrpp; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_policy
    ADD CONSTRAINT constraint_farsrpp PRIMARY KEY (resource_id, policy_id);


--
-- Name: resource_server_scope constraint_farsrs; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_scope
    ADD CONSTRAINT constraint_farsrs PRIMARY KEY (id);


--
-- Name: resource_scope constraint_farsrsp; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_scope
    ADD CONSTRAINT constraint_farsrsp PRIMARY KEY (resource_id, scope_id);


--
-- Name: scope_policy constraint_farsrsps; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_policy
    ADD CONSTRAINT constraint_farsrsps PRIMARY KEY (scope_id, policy_id);


--
-- Name: user_entity constraint_fb; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_entity
    ADD CONSTRAINT constraint_fb PRIMARY KEY (id);


--
-- Name: user_federation_mapper_config constraint_fedmapper_cfg_pm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_mapper_config
    ADD CONSTRAINT constraint_fedmapper_cfg_pm PRIMARY KEY (user_federation_mapper_id, name);


--
-- Name: user_federation_mapper constraint_fedmapperpm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_mapper
    ADD CONSTRAINT constraint_fedmapperpm PRIMARY KEY (id);


--
-- Name: fed_user_consent_cl_scope constraint_fgrntcsnt_clsc_pm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fed_user_consent_cl_scope
    ADD CONSTRAINT constraint_fgrntcsnt_clsc_pm PRIMARY KEY (user_consent_id, scope_id);


--
-- Name: user_consent_client_scope constraint_grntcsnt_clsc_pm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent_client_scope
    ADD CONSTRAINT constraint_grntcsnt_clsc_pm PRIMARY KEY (user_consent_id, scope_id);


--
-- Name: user_consent constraint_grntcsnt_pm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent
    ADD CONSTRAINT constraint_grntcsnt_pm PRIMARY KEY (id);


--
-- Name: keycloak_group constraint_group; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keycloak_group
    ADD CONSTRAINT constraint_group PRIMARY KEY (id);


--
-- Name: group_attribute constraint_group_attribute_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_attribute
    ADD CONSTRAINT constraint_group_attribute_pk PRIMARY KEY (id);


--
-- Name: group_role_mapping constraint_group_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_mapping
    ADD CONSTRAINT constraint_group_role PRIMARY KEY (role_id, group_id);


--
-- Name: identity_provider_mapper constraint_idpm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider_mapper
    ADD CONSTRAINT constraint_idpm PRIMARY KEY (id);


--
-- Name: idp_mapper_config constraint_idpmconfig; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_mapper_config
    ADD CONSTRAINT constraint_idpmconfig PRIMARY KEY (idp_mapper_id, name);


--
-- Name: migration_model constraint_migmod; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migration_model
    ADD CONSTRAINT constraint_migmod PRIMARY KEY (id);


--
-- Name: offline_client_session constraint_offl_cl_ses_pk3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_client_session
    ADD CONSTRAINT constraint_offl_cl_ses_pk3 PRIMARY KEY (user_session_id, client_id, client_storage_provider, external_client_id, offline_flag);


--
-- Name: offline_user_session constraint_offl_us_ses_pk2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offline_user_session
    ADD CONSTRAINT constraint_offl_us_ses_pk2 PRIMARY KEY (user_session_id, offline_flag);


--
-- Name: protocol_mapper constraint_pcm; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_mapper
    ADD CONSTRAINT constraint_pcm PRIMARY KEY (id);


--
-- Name: protocol_mapper_config constraint_pmconfig; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_mapper_config
    ADD CONSTRAINT constraint_pmconfig PRIMARY KEY (protocol_mapper_id, name);


--
-- Name: redirect_uris constraint_redirect_uris; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redirect_uris
    ADD CONSTRAINT constraint_redirect_uris PRIMARY KEY (client_id, value);


--
-- Name: required_action_config constraint_req_act_cfg_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.required_action_config
    ADD CONSTRAINT constraint_req_act_cfg_pk PRIMARY KEY (required_action_id, name);


--
-- Name: required_action_provider constraint_req_act_prv_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.required_action_provider
    ADD CONSTRAINT constraint_req_act_prv_pk PRIMARY KEY (id);


--
-- Name: user_required_action constraint_required_action; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_required_action
    ADD CONSTRAINT constraint_required_action PRIMARY KEY (required_action, user_id);


--
-- Name: resource_uris constraint_resour_uris_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_uris
    ADD CONSTRAINT constraint_resour_uris_pk PRIMARY KEY (resource_id, value);


--
-- Name: role_attribute constraint_role_attribute_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_attribute
    ADD CONSTRAINT constraint_role_attribute_pk PRIMARY KEY (id);


--
-- Name: revoked_token constraint_rt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revoked_token
    ADD CONSTRAINT constraint_rt PRIMARY KEY (id);


--
-- Name: user_attribute constraint_user_attribute_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attribute
    ADD CONSTRAINT constraint_user_attribute_pk PRIMARY KEY (id);


--
-- Name: user_group_membership constraint_user_group; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_membership
    ADD CONSTRAINT constraint_user_group PRIMARY KEY (group_id, user_id);


--
-- Name: web_origins constraint_web_origins; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_origins
    ADD CONSTRAINT constraint_web_origins PRIMARY KEY (client_id, value);


--
-- Name: contact_addresses contact_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_addresses
    ADD CONSTRAINT contact_addresses_pkey PRIMARY KEY (id);


--
-- Name: contact_emails contact_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_users crm_users_keycloak_sub_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_users
    ADD CONSTRAINT crm_users_keycloak_sub_key UNIQUE (keycloak_sub);


--
-- Name: crm_users crm_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_users
    ADD CONSTRAINT crm_users_pkey PRIMARY KEY (id);


--
-- Name: daily_metrics daily_metrics_date_source_segment_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_metrics
    ADD CONSTRAINT daily_metrics_date_source_segment_key UNIQUE (date, source, segment);


--
-- Name: daily_metrics daily_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_metrics
    ADD CONSTRAINT daily_metrics_pkey PRIMARY KEY (id);


--
-- Name: databasechangeloglock databasechangeloglock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.databasechangeloglock
    ADD CONSTRAINT databasechangeloglock_pkey PRIMARY KEY (id);


--
-- Name: dim_date dim_date_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dim_date
    ADD CONSTRAINT dim_date_pkey PRIMARY KEY (d);


--
-- Name: dim_source dim_source_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dim_source
    ADD CONSTRAINT dim_source_code_key UNIQUE (code);


--
-- Name: dim_source dim_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dim_source
    ADD CONSTRAINT dim_source_pkey PRIMARY KEY (id);


--
-- Name: dim_zip dim_zip_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dim_zip
    ADD CONSTRAINT dim_zip_pkey PRIMARY KEY (zip);


--
-- Name: dispatch_settings dispatch_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_settings
    ADD CONSTRAINT dispatch_settings_pkey PRIMARY KEY (id);


--
-- Name: document_attachments document_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_pkey PRIMARY KEY (id);


--
-- Name: document_deliveries document_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_deliveries
    ADD CONSTRAINT document_deliveries_pkey PRIMARY KEY (id);


--
-- Name: document_delivery_attachments document_delivery_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_delivery_attachments
    ADD CONSTRAINT document_delivery_attachments_pkey PRIMARY KEY (delivery_id, attachment_id);


--
-- Name: domain_events domain_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_pkey PRIMARY KEY (id);


--
-- Name: elocals_leads elocals_leads_lead_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.elocals_leads
    ADD CONSTRAINT elocals_leads_lead_id_key UNIQUE (lead_id);


--
-- Name: elocals_leads elocals_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.elocals_leads
    ADD CONSTRAINT elocals_leads_pkey PRIMARY KEY (id);


--
-- Name: email_attachments email_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_attachments
    ADD CONSTRAINT email_attachments_pkey PRIMARY KEY (id);


--
-- Name: email_mailboxes email_mailboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_mailboxes
    ADD CONSTRAINT email_mailboxes_pkey PRIMARY KEY (id);


--
-- Name: email_messages email_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_pkey PRIMARY KEY (id);


--
-- Name: email_sync_state email_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_state
    ADD CONSTRAINT email_sync_state_pkey PRIMARY KEY (mailbox_id);


--
-- Name: email_threads email_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_pkey PRIMARY KEY (id);


--
-- Name: estimate_events estimate_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_events
    ADD CONSTRAINT estimate_events_pkey PRIMARY KEY (id);


--
-- Name: estimate_items estimate_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_items
    ADD CONSTRAINT estimate_items_pkey PRIMARY KEY (id);


--
-- Name: estimate_revisions estimate_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_revisions
    ADD CONSTRAINT estimate_revisions_pkey PRIMARY KEY (id);


--
-- Name: estimates estimates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);


--
-- Name: fact_expense fact_expense_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_expense
    ADD CONSTRAINT fact_expense_pkey PRIMARY KEY (expense_id);


--
-- Name: fact_jobs fact_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_jobs
    ADD CONSTRAINT fact_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: fact_leads fact_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_leads
    ADD CONSTRAINT fact_leads_pkey PRIMARY KEY (lead_id);


--
-- Name: fact_parts fact_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_parts
    ADD CONSTRAINT fact_parts_pkey PRIMARY KEY (part_id);


--
-- Name: fact_payments fact_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_payments
    ADD CONSTRAINT fact_payments_pkey PRIMARY KEY (payment_id);


--
-- Name: fsm_audit_log fsm_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_audit_log
    ADD CONSTRAINT fsm_audit_log_pkey PRIMARY KEY (id);


--
-- Name: fsm_machines fsm_machines_company_id_machine_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_machines
    ADD CONSTRAINT fsm_machines_company_id_machine_key_key UNIQUE (company_id, machine_key);


--
-- Name: fsm_machines fsm_machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_machines
    ADD CONSTRAINT fsm_machines_pkey PRIMARY KEY (id);


--
-- Name: fsm_versions fsm_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_versions
    ADD CONSTRAINT fsm_versions_pkey PRIMARY KEY (id);


--
-- Name: google_spend google_spend_date_campaign_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_spend
    ADD CONSTRAINT google_spend_date_campaign_key UNIQUE (date, campaign);


--
-- Name: google_spend google_spend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_spend
    ADD CONSTRAINT google_spend_pkey PRIMARY KEY (id);


--
-- Name: invoice_events invoice_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_events
    ADD CONSTRAINT invoice_events_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoice_revisions invoice_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_revisions
    ADD CONSTRAINT invoice_revisions_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: job_tag_assignments job_tag_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tag_assignments
    ADD CONSTRAINT job_tag_assignments_pkey PRIMARY KEY (job_id, tag_id);


--
-- Name: job_tags job_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tags
    ADD CONSTRAINT job_tags_pkey PRIMARY KEY (id);


--
-- Name: job_tokens job_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tokens
    ADD CONSTRAINT job_tokens_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_zenbooker_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_zenbooker_job_id_key UNIQUE (zenbooker_job_id);


--
-- Name: kpi_targets kpi_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_targets
    ADD CONSTRAINT kpi_targets_pkey PRIMARY KEY (id);


--
-- Name: lead_custom_fields lead_custom_fields_api_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_custom_fields
    ADD CONSTRAINT lead_custom_fields_api_name_key UNIQUE (api_name);


--
-- Name: lead_custom_fields lead_custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_custom_fields
    ADD CONSTRAINT lead_custom_fields_pkey PRIMARY KEY (id);


--
-- Name: lead_job_types lead_job_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_job_types
    ADD CONSTRAINT lead_job_types_name_key UNIQUE (name);


--
-- Name: lead_job_types lead_job_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_job_types
    ADD CONSTRAINT lead_job_types_pkey PRIMARY KEY (id);


--
-- Name: lead_team_assignments lead_team_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_team_assignments
    ADD CONSTRAINT lead_team_assignments_pkey PRIMARY KEY (id);


--
-- Name: leads_legacy leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads_legacy
    ADD CONSTRAINT leads_pkey PRIMARY KEY (lead_id);


--
-- Name: leads leads_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey1 PRIMARY KEY (id);


--
-- Name: marketplace_apps marketplace_apps_app_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_apps
    ADD CONSTRAINT marketplace_apps_app_key_key UNIQUE (app_key);


--
-- Name: marketplace_apps marketplace_apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_apps
    ADD CONSTRAINT marketplace_apps_pkey PRIMARY KEY (id);


--
-- Name: marketplace_installation_events marketplace_installation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_pkey PRIMARY KEY (id);


--
-- Name: marketplace_installations marketplace_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_pkey PRIMARY KEY (id);


--
-- Name: monthly_metrics monthly_metrics_month_source_segment_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_metrics
    ADD CONSTRAINT monthly_metrics_month_source_segment_key UNIQUE (month, source, segment);


--
-- Name: monthly_metrics monthly_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monthly_metrics
    ADD CONSTRAINT monthly_metrics_pkey PRIMARY KEY (id);


--
-- Name: note_attachments note_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_attachments
    ADD CONSTRAINT note_attachments_pkey PRIMARY KEY (id);


--
-- Name: payment_receipts payment_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_receipts
    ADD CONSTRAINT payment_receipts_pkey PRIMARY KEY (id);


--
-- Name: payment_transactions payment_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_pkey PRIMARY KEY (id);


--
-- Name: payments payments_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_payment_id_key UNIQUE (payment_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: phone_number_settings phone_number_settings_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_number_settings
    ADD CONSTRAINT phone_number_settings_phone_number_key UNIQUE (phone_number);


--
-- Name: phone_number_settings phone_number_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_number_settings
    ADD CONSTRAINT phone_number_settings_pkey PRIMARY KEY (id);


--
-- Name: client_scope_attributes pk_cl_tmpl_attr; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope_attributes
    ADD CONSTRAINT pk_cl_tmpl_attr PRIMARY KEY (scope_id, name);


--
-- Name: client_scope pk_cli_template; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope
    ADD CONSTRAINT pk_cli_template PRIMARY KEY (id);


--
-- Name: resource_server pk_resource_server; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server
    ADD CONSTRAINT pk_resource_server PRIMARY KEY (id);


--
-- Name: client_scope_role_mapping pk_template_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope_role_mapping
    ADD CONSTRAINT pk_template_scope PRIMARY KEY (scope_id, role_id);


--
-- Name: portal_access_tokens portal_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_tokens
    ADD CONSTRAINT portal_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: portal_access_tokens portal_access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_tokens
    ADD CONSTRAINT portal_access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: portal_events portal_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_pkey PRIMARY KEY (id);


--
-- Name: portal_sessions portal_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_pkey PRIMARY KEY (id);


--
-- Name: provider_connections provider_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connections
    ADD CONSTRAINT provider_connections_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: quick_messages quick_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quick_messages
    ADD CONSTRAINT quick_messages_pkey PRIMARY KEY (id);


--
-- Name: default_client_scope r_def_cli_scope_bind; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.default_client_scope
    ADD CONSTRAINT r_def_cli_scope_bind PRIMARY KEY (realm_id, scope_id);


--
-- Name: rate_me_events rate_me_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_me_events
    ADD CONSTRAINT rate_me_events_pkey PRIMARY KEY (id);


--
-- Name: realm_localizations realm_localizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_localizations
    ADD CONSTRAINT realm_localizations_pkey PRIMARY KEY (realm_id, locale);


--
-- Name: recordings recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);


--
-- Name: recordings recordings_recording_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_recording_sid_key UNIQUE (recording_sid);


--
-- Name: referral_links referral_links_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_links
    ADD CONSTRAINT referral_links_customer_id_key UNIQUE (customer_id);


--
-- Name: referral_links referral_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_links
    ADD CONSTRAINT referral_links_pkey PRIMARY KEY (id);


--
-- Name: referral_links referral_links_referral_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_links
    ADD CONSTRAINT referral_links_referral_slug_key UNIQUE (referral_slug);


--
-- Name: referral_shares referral_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_shares
    ADD CONSTRAINT referral_shares_pkey PRIMARY KEY (id);


--
-- Name: resource_attribute res_attr_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_attribute
    ADD CONSTRAINT res_attr_pk PRIMARY KEY (id);


--
-- Name: rewards rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards
    ADD CONSTRAINT rewards_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: service_territories service_territories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_territories
    ADD CONSTRAINT service_territories_pkey PRIMARY KEY (company_id, zip);


--
-- Name: servicedirect_leads servicedirect_leads_lead_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servicedirect_leads
    ADD CONSTRAINT servicedirect_leads_lead_id_key UNIQUE (lead_id);


--
-- Name: servicedirect_leads servicedirect_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servicedirect_leads
    ADD CONSTRAINT servicedirect_leads_pkey PRIMARY KEY (id);


--
-- Name: keycloak_group sibling_names; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keycloak_group
    ADD CONSTRAINT sibling_names UNIQUE (realm_id, parent_group, name);


--
-- Name: sms_conversations sms_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversations
    ADD CONSTRAINT sms_conversations_pkey PRIMARY KEY (id);


--
-- Name: sms_conversations sms_conversations_twilio_conversation_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversations
    ADD CONSTRAINT sms_conversations_twilio_conversation_sid_key UNIQUE (twilio_conversation_sid);


--
-- Name: sms_events sms_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_events
    ADD CONSTRAINT sms_events_pkey PRIMARY KEY (id);


--
-- Name: sms_media sms_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_media
    ADD CONSTRAINT sms_media_pkey PRIMARY KEY (id);


--
-- Name: sms_media sms_media_twilio_media_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_media
    ADD CONSTRAINT sms_media_twilio_media_sid_key UNIQUE (twilio_media_sid);


--
-- Name: sms_messages sms_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_pkey PRIMARY KEY (id);


--
-- Name: sms_messages sms_messages_twilio_message_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_twilio_message_sid_key UNIQUE (twilio_message_sid);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (job_name);


--
-- Name: targets targets_month_source_segment_metric_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_month_source_segment_metric_type_key UNIQUE (month, source, segment, metric_type);


--
-- Name: targets targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: timelines timelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timelines
    ADD CONSTRAINT timelines_pkey PRIMARY KEY (id);


--
-- Name: transcripts transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_pkey PRIMARY KEY (id);


--
-- Name: transcripts transcripts_transcription_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_transcription_sid_key UNIQUE (transcription_sid);


--
-- Name: identity_provider uk_2daelwnibji49avxsrtuf6xj33; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider
    ADD CONSTRAINT uk_2daelwnibji49avxsrtuf6xj33 UNIQUE (provider_alias, realm_id);


--
-- Name: client uk_b71cjlbenv945rb6gcon438at; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client
    ADD CONSTRAINT uk_b71cjlbenv945rb6gcon438at UNIQUE (realm_id, client_id);


--
-- Name: client_scope uk_cli_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope
    ADD CONSTRAINT uk_cli_scope UNIQUE (realm_id, name);


--
-- Name: user_entity uk_dykn684sl8up1crfei6eckhd7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_entity
    ADD CONSTRAINT uk_dykn684sl8up1crfei6eckhd7 UNIQUE (realm_id, email_constraint);


--
-- Name: user_consent uk_external_consent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent
    ADD CONSTRAINT uk_external_consent UNIQUE (client_storage_provider, external_client_id, user_id);


--
-- Name: resource_server_resource uk_frsr6t700s9v50bu18ws5ha6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_resource
    ADD CONSTRAINT uk_frsr6t700s9v50bu18ws5ha6 UNIQUE (name, owner, resource_server_id);


--
-- Name: resource_server_perm_ticket uk_frsr6t700s9v50bu18ws5pmt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT uk_frsr6t700s9v50bu18ws5pmt UNIQUE (owner, requester, resource_server_id, resource_id, scope_id);


--
-- Name: resource_server_policy uk_frsrpt700s9v50bu18ws5ha6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_policy
    ADD CONSTRAINT uk_frsrpt700s9v50bu18ws5ha6 UNIQUE (name, resource_server_id);


--
-- Name: resource_server_scope uk_frsrst700s9v50bu18ws5ha6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_scope
    ADD CONSTRAINT uk_frsrst700s9v50bu18ws5ha6 UNIQUE (name, resource_server_id);


--
-- Name: user_consent uk_local_consent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent
    ADD CONSTRAINT uk_local_consent UNIQUE (client_id, user_id);


--
-- Name: org uk_org_alias; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT uk_org_alias UNIQUE (realm_id, alias);


--
-- Name: org uk_org_group; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT uk_org_group UNIQUE (group_id);


--
-- Name: org uk_org_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org
    ADD CONSTRAINT uk_org_name UNIQUE (realm_id, name);


--
-- Name: realm uk_orvsdmla56612eaefiq6wl5oi; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm
    ADD CONSTRAINT uk_orvsdmla56612eaefiq6wl5oi UNIQUE (name);


--
-- Name: user_entity uk_ru8tt6t700s9v50bu18ws5ha6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_entity
    ADD CONSTRAINT uk_ru8tt6t700s9v50bu18ws5ha6 UNIQUE (realm_id, username);


--
-- Name: company_role_configs uq_company_role_config; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_configs
    ADD CONSTRAINT uq_company_role_config UNIQUE (company_id, role_key);


--
-- Name: contact_emails uq_contact_emails_contact_email; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT uq_contact_emails_contact_email UNIQUE (contact_id, email_normalized);


--
-- Name: contacts uq_contacts_zenbooker_customer_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT uq_contacts_zenbooker_customer_id UNIQUE (zenbooker_customer_id);


--
-- Name: dispatch_settings uq_dispatch_settings_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_settings
    ADD CONSTRAINT uq_dispatch_settings_company UNIQUE (company_id);


--
-- Name: estimate_revisions uq_estimate_revision; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_revisions
    ADD CONSTRAINT uq_estimate_revision UNIQUE (estimate_id, revision_number);


--
-- Name: estimates uq_estimates_number_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT uq_estimates_number_company UNIQUE (company_id, estimate_number);


--
-- Name: invoice_revisions uq_invoice_revision; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_revisions
    ADD CONSTRAINT uq_invoice_revision UNIQUE (invoice_id, revision_number);


--
-- Name: invoices uq_invoices_number_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT uq_invoices_number_company UNIQUE (company_id, invoice_number);


--
-- Name: company_membership_permission_overrides uq_membership_perm_override; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_permission_overrides
    ADD CONSTRAINT uq_membership_perm_override UNIQUE (membership_id, permission_key);


--
-- Name: company_membership_scope_overrides uq_membership_scope_override; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_scope_overrides
    ADD CONSTRAINT uq_membership_scope_override UNIQUE (membership_id, scope_key);


--
-- Name: company_role_permissions uq_role_permission; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_permissions
    ADD CONSTRAINT uq_role_permission UNIQUE (role_config_id, permission_key);


--
-- Name: company_role_scopes uq_role_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_scopes
    ADD CONSTRAINT uq_role_scope UNIQUE (role_config_id, scope_key);


--
-- Name: company_memberships uq_user_company; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT uq_user_company UNIQUE (user_id, company_id);


--
-- Name: company_user_service_areas uq_user_service_area; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_service_areas
    ADD CONSTRAINT uq_user_service_area UNIQUE (membership_id, service_area_id);


--
-- Name: company_user_skills uq_user_skill; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_skills
    ADD CONSTRAINT uq_user_skill UNIQUE (membership_id, job_type_id);


--
-- Name: zb_payments uq_zb_payments_company_txn; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zb_payments
    ADD CONSTRAINT uq_zb_payments_company_txn UNIQUE (company_id, transaction_id);


--
-- Name: user_group_hours user_group_hours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_hours
    ADD CONSTRAINT user_group_hours_pkey PRIMARY KEY (id);


--
-- Name: user_group_members user_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_pkey PRIMARY KEY (id);


--
-- Name: user_group_numbers user_group_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_numbers
    ADD CONSTRAINT user_group_numbers_pkey PRIMARY KEY (id);


--
-- Name: user_groups user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);


--
-- Name: vapi_assistant_profiles vapi_assistant_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vapi_assistant_profiles
    ADD CONSTRAINT vapi_assistant_profiles_pkey PRIMARY KEY (id);


--
-- Name: vapi_tenant_resources vapi_tenant_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vapi_tenant_resources
    ADD CONSTRAINT vapi_tenant_resources_pkey PRIMARY KEY (id);


--
-- Name: webhook_inbox webhook_inbox_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_event_key_key UNIQUE (event_key);


--
-- Name: webhook_inbox webhook_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_pkey PRIMARY KEY (id);


--
-- Name: zb_payments zb_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zb_payments
    ADD CONSTRAINT zb_payments_pkey PRIMARY KEY (id);


--
-- Name: fed_user_attr_long_values; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fed_user_attr_long_values ON public.fed_user_attribute USING btree (long_value_hash, name);


--
-- Name: fed_user_attr_long_values_lower_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fed_user_attr_long_values_lower_case ON public.fed_user_attribute USING btree (long_value_hash_lower_case, name);


--
-- Name: idx_admin_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_event_time ON public.admin_event_entity USING btree (realm_id, admin_event_time);


--
-- Name: idx_agent_presence_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_presence_company_status ON public.agent_presence USING btree (company_id, status, expires_at);


--
-- Name: idx_agent_presence_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_presence_expires ON public.agent_presence USING btree (expires_at);


--
-- Name: idx_api_integrations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_integrations_active ON public.api_integrations USING btree (key_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_api_integrations_key_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_integrations_key_id ON public.api_integrations USING btree (key_id);


--
-- Name: idx_api_integrations_marketplace_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_integrations_marketplace_app ON public.api_integrations USING btree (marketplace_app_id);


--
-- Name: idx_api_integrations_marketplace_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_integrations_marketplace_installation ON public.api_integrations USING btree (marketplace_installation_id);


--
-- Name: idx_assoc_pol_assoc_pol_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assoc_pol_assoc_pol_id ON public.associated_policy USING btree (associated_policy_id);


--
-- Name: idx_audit_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_action ON public.audit_log USING btree (action);


--
-- Name: idx_audit_log_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_actor ON public.audit_log USING btree (actor_id);


--
-- Name: idx_audit_log_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_company ON public.audit_log USING btree (company_id);


--
-- Name: idx_audit_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_created ON public.audit_log USING btree (created_at DESC);


--
-- Name: idx_auth_config_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_config_realm ON public.authenticator_config USING btree (realm_id);


--
-- Name: idx_auth_exec_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_exec_flow ON public.authentication_execution USING btree (flow_id);


--
-- Name: idx_auth_exec_realm_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_exec_realm_flow ON public.authentication_execution USING btree (realm_id, flow_id);


--
-- Name: idx_auth_flow_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_flow_realm ON public.authentication_flow USING btree (realm_id);


--
-- Name: idx_call_events_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_company_id ON public.call_events USING btree (company_id);


--
-- Name: idx_call_flow_executions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_flow_executions_company ON public.call_flow_executions USING btree (company_id);


--
-- Name: idx_call_flow_executions_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_flow_executions_group ON public.call_flow_executions USING btree (group_id);


--
-- Name: idx_call_flows_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_flows_company ON public.call_flows USING btree (company_id);


--
-- Name: idx_call_flows_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_flows_group ON public.call_flows USING btree (group_id);


--
-- Name: idx_calls_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_company_id ON public.calls USING btree (company_id);


--
-- Name: idx_calls_contact_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_contact_started ON public.calls USING btree (contact_id, started_at DESC);


--
-- Name: idx_calls_not_final; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_not_final ON public.calls USING btree (status, started_at DESC) WHERE (is_final = false);


--
-- Name: idx_calls_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_parent ON public.calls USING btree (parent_call_sid) WHERE (parent_call_sid IS NOT NULL);


--
-- Name: idx_calls_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_status_updated ON public.calls USING btree (status, updated_at DESC);


--
-- Name: idx_calls_timeline_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_timeline_id ON public.calls USING btree (timeline_id);


--
-- Name: idx_cl_clscope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cl_clscope ON public.client_scope_client USING btree (scope_id);


--
-- Name: idx_client_att_by_name_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_att_by_name_value ON public.client_attributes USING btree (name, substr(value, 1, 255));


--
-- Name: idx_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_id ON public.client USING btree (client_id);


--
-- Name: idx_client_init_acc_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_init_acc_realm ON public.client_initial_access USING btree (realm_id);


--
-- Name: idx_clscope_attrs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clscope_attrs ON public.client_scope_attributes USING btree (scope_id);


--
-- Name: idx_clscope_cl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clscope_cl ON public.client_scope_client USING btree (client_id);


--
-- Name: idx_clscope_protmap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clscope_protmap ON public.protocol_mapper USING btree (client_scope_id);


--
-- Name: idx_clscope_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clscope_role ON public.client_scope_role_mapping USING btree (scope_id);


--
-- Name: idx_companies_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_slug ON public.companies USING btree (slug);


--
-- Name: idx_companies_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_status ON public.companies USING btree (status);


--
-- Name: idx_compo_config_compo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compo_config_compo ON public.component_config USING btree (component_id);


--
-- Name: idx_component_provider_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_component_provider_type ON public.component USING btree (provider_type);


--
-- Name: idx_component_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_component_realm ON public.component USING btree (realm_id);


--
-- Name: idx_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_composite ON public.composite_role USING btree (composite);


--
-- Name: idx_composite_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_composite_child ON public.composite_role USING btree (child_role);


--
-- Name: idx_contact_addresses_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_addresses_contact_id ON public.contact_addresses USING btree (contact_id);


--
-- Name: idx_contact_addresses_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_addresses_hash ON public.contact_addresses USING btree (contact_id, address_normalized_hash);


--
-- Name: idx_contact_addresses_place_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_addresses_place_id ON public.contact_addresses USING btree (google_place_id) WHERE (google_place_id IS NOT NULL);


--
-- Name: idx_contact_emails_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_emails_contact_id ON public.contact_emails USING btree (contact_id);


--
-- Name: idx_contact_emails_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_emails_normalized ON public.contact_emails USING btree (email_normalized);


--
-- Name: idx_contacts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_company_id ON public.contacts USING btree (company_id);


--
-- Name: idx_contacts_name_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_name_lower ON public.contacts USING btree (lower(TRIM(BOTH FROM first_name)), lower(TRIM(BOTH FROM last_name)));


--
-- Name: idx_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_phone ON public.contacts USING btree (phone_e164) WHERE (phone_e164 IS NOT NULL);


--
-- Name: idx_contacts_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_unread ON public.contacts USING btree (has_unread, updated_at DESC);


--
-- Name: idx_crm_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_users_email ON public.crm_users USING btree (email);


--
-- Name: idx_crm_users_platform_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_users_platform_role ON public.crm_users USING btree (platform_role);


--
-- Name: idx_crm_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_users_status ON public.crm_users USING btree (status);


--
-- Name: idx_daily_metrics_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_metrics_date ON public.daily_metrics USING btree (date);


--
-- Name: idx_daily_metrics_date_source_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_metrics_date_source_segment ON public.daily_metrics USING btree (date, source, segment);


--
-- Name: idx_daily_metrics_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_metrics_segment ON public.daily_metrics USING btree (segment);


--
-- Name: idx_daily_metrics_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_metrics_source ON public.daily_metrics USING btree (source);


--
-- Name: idx_dda_attachment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dda_attachment ON public.document_delivery_attachments USING btree (attachment_id);


--
-- Name: idx_defcls_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defcls_realm ON public.default_client_scope USING btree (realm_id);


--
-- Name: idx_defcls_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defcls_scope ON public.default_client_scope USING btree (scope_id);


--
-- Name: idx_document_attachments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_attachments_company ON public.document_attachments USING btree (company_id);


--
-- Name: idx_document_attachments_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_attachments_document ON public.document_attachments USING btree (document_type, document_id);


--
-- Name: idx_document_deliveries_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_deliveries_company ON public.document_deliveries USING btree (company_id);


--
-- Name: idx_document_deliveries_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_deliveries_document ON public.document_deliveries USING btree (document_type, document_id);


--
-- Name: idx_document_deliveries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_deliveries_status ON public.document_deliveries USING btree (status) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('sent'::character varying)::text]));


--
-- Name: idx_domain_events_aggregate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domain_events_aggregate ON public.domain_events USING btree (aggregate_type, aggregate_id, created_at);


--
-- Name: idx_domain_events_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domain_events_company_created ON public.domain_events USING btree (company_id, created_at DESC);


--
-- Name: idx_domain_events_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_domain_events_idempotency ON public.domain_events USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_domain_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domain_events_type ON public.domain_events USING btree (event_type);


--
-- Name: idx_elocals_leads_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_elocals_leads_date ON public.elocals_leads USING btree (date);


--
-- Name: idx_email_attachments_company_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_attachments_company_type ON public.email_attachments USING btree (company_id, content_type);


--
-- Name: idx_email_attachments_message_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_attachments_message_order ON public.email_attachments USING btree (message_id, sort_order);


--
-- Name: idx_email_mailbox_status_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_mailbox_status_sync ON public.email_mailboxes USING btree (status, last_synced_at);


--
-- Name: idx_email_messages_company_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_messages_company_from ON public.email_messages USING btree (company_id, from_email);


--
-- Name: idx_email_messages_thread_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_messages_thread_time ON public.email_messages USING btree (thread_id, gmail_internal_at);


--
-- Name: idx_email_threads_company_attachments; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_threads_company_attachments ON public.email_threads USING btree (company_id, has_attachments);


--
-- Name: idx_email_threads_company_last_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_threads_company_last_msg ON public.email_threads USING btree (company_id, last_message_at DESC);


--
-- Name: idx_email_threads_company_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_threads_company_unread ON public.email_threads USING btree (company_id, unread_count);


--
-- Name: idx_email_threads_mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_threads_mailbox ON public.email_threads USING btree (mailbox_id);


--
-- Name: idx_estimate_events_estimate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimate_events_estimate ON public.estimate_events USING btree (estimate_id, created_at);


--
-- Name: idx_estimate_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimate_events_type ON public.estimate_events USING btree (event_type);


--
-- Name: idx_estimate_items_estimate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimate_items_estimate ON public.estimate_items USING btree (estimate_id, sort_order);


--
-- Name: idx_estimate_revisions_estimate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimate_revisions_estimate ON public.estimate_revisions USING btree (estimate_id);


--
-- Name: idx_estimates_company_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_company_archived ON public.estimates USING btree (company_id, archived_at);


--
-- Name: idx_estimates_company_job_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_company_job_sequence ON public.estimates USING btree (company_id, job_id, estimate_sequence) WHERE (job_id IS NOT NULL);


--
-- Name: idx_estimates_company_lead_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_company_lead_sequence ON public.estimates USING btree (company_id, lead_id, estimate_sequence) WHERE (lead_id IS NOT NULL);


--
-- Name: idx_estimates_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_company_status ON public.estimates USING btree (company_id, status);


--
-- Name: idx_estimates_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_contact ON public.estimates USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_estimates_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_job ON public.estimates USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: idx_estimates_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estimates_lead ON public.estimates USING btree (lead_id) WHERE (lead_id IS NOT NULL);


--
-- Name: idx_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_time ON public.event_entity USING btree (realm_id, event_time);


--
-- Name: idx_events_call_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_call_time ON public.call_events USING btree (call_sid, event_time DESC);


--
-- Name: idx_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_created ON public.call_events USING btree (created_at DESC);


--
-- Name: idx_events_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_source ON public.call_events USING btree (source, created_at DESC);


--
-- Name: idx_events_type_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type_time ON public.call_events USING btree (event_type, event_time DESC);


--
-- Name: idx_fact_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_created_at ON public.fact_jobs USING btree (created_at);


--
-- Name: idx_fact_jobs_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_lead_id ON public.fact_jobs USING btree (lead_id);


--
-- Name: idx_fact_jobs_meta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_meta ON public.fact_jobs USING gin (meta);


--
-- Name: idx_fact_jobs_scheduled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_scheduled_at ON public.fact_jobs USING btree (scheduled_at);


--
-- Name: idx_fact_jobs_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_source_id ON public.fact_jobs USING btree (source_id);


--
-- Name: idx_fact_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_status ON public.fact_jobs USING btree (status);


--
-- Name: idx_fact_jobs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_jobs_type ON public.fact_jobs USING btree (type);


--
-- Name: idx_fact_leads_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_city ON public.fact_leads USING btree (city);


--
-- Name: idx_fact_leads_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_created_at ON public.fact_leads USING btree (created_at);


--
-- Name: idx_fact_leads_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_job_id ON public.fact_leads USING btree (job_id);


--
-- Name: idx_fact_leads_job_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_job_source ON public.fact_leads USING btree (job_source);


--
-- Name: idx_fact_leads_job_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_job_type ON public.fact_leads USING btree (job_type);


--
-- Name: idx_fact_leads_last_status_update; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_last_status_update ON public.fact_leads USING btree (last_status_update);


--
-- Name: idx_fact_leads_lead_date_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_lead_date_time ON public.fact_leads USING btree (lead_date_time);


--
-- Name: idx_fact_leads_meta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_meta ON public.fact_leads USING gin (meta);


--
-- Name: idx_fact_leads_phone_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_phone_hash ON public.fact_leads USING btree (phone_hash);


--
-- Name: idx_fact_leads_postal_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_postal_code ON public.fact_leads USING btree (postal_code);


--
-- Name: idx_fact_leads_serial_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_serial_id ON public.fact_leads USING btree (serial_id);


--
-- Name: idx_fact_leads_service_area; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_service_area ON public.fact_leads USING btree (service_area);


--
-- Name: idx_fact_leads_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_source_id ON public.fact_leads USING btree (source_id);


--
-- Name: idx_fact_leads_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_state ON public.fact_leads USING btree (state);


--
-- Name: idx_fact_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_status ON public.fact_leads USING btree (status);


--
-- Name: idx_fact_leads_sub_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_sub_status ON public.fact_leads USING btree (sub_status);


--
-- Name: idx_fact_leads_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_tags ON public.fact_leads USING gin (tags);


--
-- Name: idx_fact_leads_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_leads_team ON public.fact_leads USING gin (team);


--
-- Name: idx_fact_payments_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_payments_job_id ON public.fact_payments USING btree (job_id);


--
-- Name: idx_fact_payments_meta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_payments_meta ON public.fact_payments USING gin (meta);


--
-- Name: idx_fact_payments_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fact_payments_paid_at ON public.fact_payments USING btree (paid_at);


--
-- Name: idx_fedidentity_feduser; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fedidentity_feduser ON public.federated_identity USING btree (federated_user_id);


--
-- Name: idx_fedidentity_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fedidentity_user ON public.federated_identity USING btree (user_id);


--
-- Name: idx_fsm_audit_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_audit_company ON public.fsm_audit_log USING btree (company_id);


--
-- Name: idx_fsm_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_audit_created ON public.fsm_audit_log USING btree (created_at);


--
-- Name: idx_fsm_audit_machine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_audit_machine ON public.fsm_audit_log USING btree (machine_key);


--
-- Name: idx_fsm_machines_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_machines_company ON public.fsm_machines USING btree (company_id);


--
-- Name: idx_fsm_versions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_versions_company ON public.fsm_versions USING btree (company_id);


--
-- Name: idx_fsm_versions_machine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_versions_machine ON public.fsm_versions USING btree (machine_id);


--
-- Name: idx_fsm_versions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fsm_versions_status ON public.fsm_versions USING btree (status);


--
-- Name: idx_fu_attribute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_attribute ON public.fed_user_attribute USING btree (user_id, realm_id, name);


--
-- Name: idx_fu_cnsnt_ext; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_cnsnt_ext ON public.fed_user_consent USING btree (user_id, client_storage_provider, external_client_id);


--
-- Name: idx_fu_consent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_consent ON public.fed_user_consent USING btree (user_id, client_id);


--
-- Name: idx_fu_consent_ru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_consent_ru ON public.fed_user_consent USING btree (realm_id, user_id);


--
-- Name: idx_fu_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_credential ON public.fed_user_credential USING btree (user_id, type);


--
-- Name: idx_fu_credential_ru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_credential_ru ON public.fed_user_credential USING btree (realm_id, user_id);


--
-- Name: idx_fu_group_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_group_membership ON public.fed_user_group_membership USING btree (user_id, group_id);


--
-- Name: idx_fu_group_membership_ru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_group_membership_ru ON public.fed_user_group_membership USING btree (realm_id, user_id);


--
-- Name: idx_fu_required_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_required_action ON public.fed_user_required_action USING btree (user_id, required_action);


--
-- Name: idx_fu_required_action_ru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_required_action_ru ON public.fed_user_required_action USING btree (realm_id, user_id);


--
-- Name: idx_fu_role_mapping; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_role_mapping ON public.fed_user_role_mapping USING btree (user_id, role_id);


--
-- Name: idx_fu_role_mapping_ru; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fu_role_mapping_ru ON public.fed_user_role_mapping USING btree (realm_id, user_id);


--
-- Name: idx_google_spend_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_spend_date ON public.google_spend USING btree (date);


--
-- Name: idx_google_spend_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_google_spend_month ON public.google_spend USING btree (month);


--
-- Name: idx_group_att_by_name_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_att_by_name_value ON public.group_attribute USING btree (name, ((value)::character varying(250)));


--
-- Name: idx_group_attr_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_attr_group ON public.group_attribute USING btree (group_id);


--
-- Name: idx_group_role_mapp_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_role_mapp_group ON public.group_role_mapping USING btree (group_id);


--
-- Name: idx_id_prov_mapp_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_id_prov_mapp_realm ON public.identity_provider_mapper USING btree (realm_id);


--
-- Name: idx_ident_prov_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ident_prov_realm ON public.identity_provider USING btree (realm_id);


--
-- Name: idx_idp_for_login; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_for_login ON public.identity_provider USING btree (realm_id, enabled, link_only, hide_on_login, organization_id);


--
-- Name: idx_idp_realm_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_realm_org ON public.identity_provider USING btree (realm_id, organization_id);


--
-- Name: idx_inbox_call_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_call_received ON public.webhook_inbox USING btree (call_sid, received_at DESC);


--
-- Name: idx_inbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_pending ON public.webhook_inbox USING btree (received_at) WHERE ((status)::text = 'received'::text);


--
-- Name: idx_inbox_status_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inbox_status_received ON public.webhook_inbox USING btree (status, received_at);


--
-- Name: idx_invitations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_company ON public.company_invitations USING btree (company_id);


--
-- Name: idx_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_email ON public.company_invitations USING btree (email);


--
-- Name: idx_invitations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_status ON public.company_invitations USING btree (status);


--
-- Name: idx_invoice_events_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_events_invoice ON public.invoice_events USING btree (invoice_id, created_at);


--
-- Name: idx_invoice_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_events_type ON public.invoice_events USING btree (event_type);


--
-- Name: idx_invoice_items_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_invoice ON public.invoice_items USING btree (invoice_id, sort_order);


--
-- Name: idx_invoice_revisions_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_revisions_invoice ON public.invoice_revisions USING btree (invoice_id);


--
-- Name: idx_invoices_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company_status ON public.invoices USING btree (company_id, status);


--
-- Name: idx_invoices_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_contact ON public.invoices USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_invoices_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_due_date ON public.invoices USING btree (due_date) WHERE ((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('viewed'::character varying)::text, ('partial'::character varying)::text, ('overdue'::character varying)::text]));


--
-- Name: idx_invoices_estimate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_estimate ON public.invoices USING btree (estimate_id) WHERE (estimate_id IS NOT NULL);


--
-- Name: idx_invoices_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_job ON public.invoices USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: idx_invoices_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_lead ON public.invoices USING btree (lead_id) WHERE (lead_id IS NOT NULL);


--
-- Name: idx_job_tokens_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_tokens_customer_id ON public.job_tokens USING btree (customer_id);


--
-- Name: idx_job_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_tokens_expires_at ON public.job_tokens USING btree (expires_at);


--
-- Name: idx_job_tokens_job_serial_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_tokens_job_serial_id ON public.job_tokens USING btree (job_serial_id);


--
-- Name: idx_job_tokens_job_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_job_tokens_job_uuid ON public.job_tokens USING btree (job_uuid);


--
-- Name: idx_job_tokens_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_tokens_status ON public.job_tokens USING btree (status);


--
-- Name: idx_jobs_blanc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_blanc_status ON public.jobs USING btree (blanc_status);


--
-- Name: idx_jobs_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_company_id ON public.jobs USING btree (company_id);


--
-- Name: idx_jobs_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_contact_id ON public.jobs USING btree (contact_id);


--
-- Name: idx_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_created_at ON public.jobs USING btree (created_at DESC);


--
-- Name: idx_jobs_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_lead_id ON public.jobs USING btree (lead_id);


--
-- Name: idx_jobs_start_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_start_date ON public.jobs USING btree (start_date DESC);


--
-- Name: idx_jobs_zenbooker_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_zenbooker_job_id ON public.jobs USING btree (zenbooker_job_id);


--
-- Name: idx_keycloak_role_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_keycloak_role_client ON public.keycloak_role USING btree (client);


--
-- Name: idx_keycloak_role_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_keycloak_role_realm ON public.keycloak_role USING btree (realm);


--
-- Name: idx_kpi_targets_metric; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_targets_metric ON public.kpi_targets USING btree (metric);


--
-- Name: idx_kpi_targets_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_targets_period ON public.kpi_targets USING btree (period_type, period_start);


--
-- Name: idx_kpi_targets_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_targets_source ON public.kpi_targets USING btree (source);


--
-- Name: idx_lead_custom_fields_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_custom_fields_company_id ON public.lead_custom_fields USING btree (company_id);


--
-- Name: idx_lead_job_types_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_job_types_company_id ON public.lead_job_types USING btree (company_id);


--
-- Name: idx_lead_team_assignments_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_team_assignments_company_id ON public.lead_team_assignments USING btree (company_id);


--
-- Name: idx_leads_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_company_id ON public.leads USING btree (company_id);


--
-- Name: idx_leads_contact_address_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_contact_address_id ON public.leads USING btree (contact_address_id) WHERE (contact_address_id IS NOT NULL);


--
-- Name: idx_leads_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_job_id ON public.leads_legacy USING btree (job_id);


--
-- Name: idx_leads_phone_last10; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_phone_last10 ON public.leads USING btree ("right"(regexp_replace((phone)::text, '[^0-9]'::text, ''::text, 'g'::text), 10)) WHERE ((status)::text <> ALL (ARRAY[('Lost'::character varying)::text, ('Converted'::character varying)::text]));


--
-- Name: idx_leads_raw_payload; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_raw_payload ON public.leads_legacy USING gin (raw_payload);


--
-- Name: idx_leads_source_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_source_created_at ON public.leads_legacy USING btree (source, created_at);


--
-- Name: idx_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_status ON public.leads_legacy USING btree (status);


--
-- Name: idx_leads_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_leads_uuid ON public.leads USING btree (uuid);


--
-- Name: idx_lta_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lta_lead_id ON public.lead_team_assignments USING btree (lead_id);


--
-- Name: idx_marketplace_apps_requested_scopes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_apps_requested_scopes ON public.marketplace_apps USING gin (requested_scopes);


--
-- Name: idx_marketplace_apps_status_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_apps_status_category ON public.marketplace_apps USING btree (status, category);


--
-- Name: idx_marketplace_events_company_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_events_company_created ON public.marketplace_installation_events USING btree (company_id, created_at DESC);


--
-- Name: idx_marketplace_events_installation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_events_installation ON public.marketplace_installation_events USING btree (installation_id);


--
-- Name: idx_marketplace_installations_api_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_installations_api_integration ON public.marketplace_installations USING btree (api_integration_id);


--
-- Name: idx_marketplace_installations_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_installations_company_status ON public.marketplace_installations USING btree (company_id, status);


--
-- Name: idx_marketplace_installations_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_marketplace_installations_one_active ON public.marketplace_installations USING btree (company_id, app_id) WHERE (status = ANY (ARRAY['connected'::text, 'provisioning_failed'::text]));


--
-- Name: idx_membership_perm_overrides; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_perm_overrides ON public.company_membership_permission_overrides USING btree (membership_id);


--
-- Name: idx_membership_scope_overrides; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_membership_scope_overrides ON public.company_membership_scope_overrides USING btree (membership_id);


--
-- Name: idx_memberships_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_company ON public.company_memberships USING btree (company_id);


--
-- Name: idx_memberships_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_role ON public.company_memberships USING btree (role);


--
-- Name: idx_memberships_role_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_role_key ON public.company_memberships USING btree (role_key);


--
-- Name: idx_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user ON public.company_memberships USING btree (user_id);


--
-- Name: idx_monthly_metrics_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monthly_metrics_month ON public.monthly_metrics USING btree (month);


--
-- Name: idx_monthly_metrics_month_source_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monthly_metrics_month_source_segment ON public.monthly_metrics USING btree (month, source, segment);


--
-- Name: idx_monthly_metrics_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monthly_metrics_segment ON public.monthly_metrics USING btree (segment);


--
-- Name: idx_monthly_metrics_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monthly_metrics_source ON public.monthly_metrics USING btree (source);


--
-- Name: idx_note_attachments_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_attachments_company ON public.note_attachments USING btree (company_id);


--
-- Name: idx_note_attachments_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_note_attachments_entity ON public.note_attachments USING btree (entity_type, entity_id);


--
-- Name: idx_offline_uss_by_broker_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offline_uss_by_broker_session_id ON public.offline_user_session USING btree (broker_session_id, realm_id);


--
-- Name: idx_offline_uss_by_last_session_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offline_uss_by_last_session_refresh ON public.offline_user_session USING btree (realm_id, offline_flag, last_session_refresh);


--
-- Name: idx_offline_uss_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offline_uss_by_user ON public.offline_user_session USING btree (user_id, realm_id, offline_flag);


--
-- Name: idx_org_domain_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_domain_org_id ON public.org_domain USING btree (org_id);


--
-- Name: idx_payment_receipts_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_receipts_transaction ON public.payment_receipts USING btree (transaction_id);


--
-- Name: idx_payment_tx_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_company_status ON public.payment_transactions USING btree (company_id, status);


--
-- Name: idx_payment_tx_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_contact ON public.payment_transactions USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_payment_tx_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_created ON public.payment_transactions USING btree (created_at DESC);


--
-- Name: idx_payment_tx_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_external ON public.payment_transactions USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_payment_tx_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_tx_invoice ON public.payment_transactions USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);


--
-- Name: idx_payments_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_date ON public.payments USING btree (date);


--
-- Name: idx_payments_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_job_id ON public.payments USING btree (job_id);


--
-- Name: idx_perm_ticket_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perm_ticket_owner ON public.resource_server_perm_ticket USING btree (owner);


--
-- Name: idx_perm_ticket_requester; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perm_ticket_requester ON public.resource_server_perm_ticket USING btree (requester);


--
-- Name: idx_phone_number_settings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_number_settings_company ON public.phone_number_settings USING btree (company_id);


--
-- Name: idx_phone_number_settings_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_number_settings_group ON public.phone_number_settings USING btree (group_id);


--
-- Name: idx_portal_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_events_session ON public.portal_events USING btree (session_id, created_at);


--
-- Name: idx_portal_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_events_type ON public.portal_events USING btree (event_type);


--
-- Name: idx_portal_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_sessions_active ON public.portal_sessions USING btree (started_at DESC) WHERE (ended_at IS NULL);


--
-- Name: idx_portal_sessions_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_sessions_contact ON public.portal_sessions USING btree (contact_id);


--
-- Name: idx_portal_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_sessions_token ON public.portal_sessions USING btree (token_id);


--
-- Name: idx_portal_tokens_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_tokens_company ON public.portal_access_tokens USING btree (company_id);


--
-- Name: idx_portal_tokens_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_tokens_contact ON public.portal_access_tokens USING btree (contact_id);


--
-- Name: idx_portal_tokens_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_tokens_expires ON public.portal_access_tokens USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_protocol_mapper_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_protocol_mapper_client ON public.protocol_mapper USING btree (client_id);


--
-- Name: idx_push_subs_company_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_company_active ON public.push_subscriptions USING btree (company_id, is_active) WHERE (is_active = true);


--
-- Name: idx_push_subs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_user ON public.push_subscriptions USING btree (user_id) WHERE (is_active = true);


--
-- Name: idx_quick_messages_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quick_messages_company ON public.quick_messages USING btree (company_id, sort_order);


--
-- Name: idx_rate_me_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_me_events_created_at ON public.rate_me_events USING btree (created_at);


--
-- Name: idx_rate_me_events_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_me_events_customer_id ON public.rate_me_events USING btree (customer_id);


--
-- Name: idx_rate_me_events_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_me_events_data ON public.rate_me_events USING gin (data);


--
-- Name: idx_rate_me_events_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_me_events_job_id ON public.rate_me_events USING btree (job_id);


--
-- Name: idx_rate_me_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_me_events_type ON public.rate_me_events USING btree (event_type);


--
-- Name: idx_realm_attr_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_attr_realm ON public.realm_attribute USING btree (realm_id);


--
-- Name: idx_realm_clscope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_clscope ON public.client_scope USING btree (realm_id);


--
-- Name: idx_realm_def_grp_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_def_grp_realm ON public.realm_default_groups USING btree (realm_id);


--
-- Name: idx_realm_evt_list_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_evt_list_realm ON public.realm_events_listeners USING btree (realm_id);


--
-- Name: idx_realm_evt_types_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_evt_types_realm ON public.realm_enabled_event_types USING btree (realm_id);


--
-- Name: idx_realm_master_adm_cli; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_master_adm_cli ON public.realm USING btree (master_admin_client);


--
-- Name: idx_realm_supp_local_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_realm_supp_local_realm ON public.realm_supported_locales USING btree (realm_id);


--
-- Name: idx_recordings_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordings_call ON public.recordings USING btree (call_sid);


--
-- Name: idx_recordings_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordings_company_id ON public.recordings USING btree (company_id);


--
-- Name: idx_recordings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordings_status ON public.recordings USING btree (status, updated_at DESC);


--
-- Name: idx_redir_uri_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redir_uri_client ON public.redirect_uris USING btree (client_id);


--
-- Name: idx_referral_links_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_links_customer_id ON public.referral_links USING btree (customer_id);


--
-- Name: idx_referral_links_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_referral_links_slug ON public.referral_links USING btree (referral_slug);


--
-- Name: idx_referral_shares_link_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_shares_link_id ON public.referral_shares USING btree (referral_link_id);


--
-- Name: idx_referral_shares_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_shares_phone ON public.referral_shares USING btree (recipient_phone);


--
-- Name: idx_referral_shares_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_shares_sent_at ON public.referral_shares USING btree (sent_at);


--
-- Name: idx_req_act_prov_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_req_act_prov_realm ON public.required_action_provider USING btree (realm_id);


--
-- Name: idx_res_policy_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_res_policy_policy ON public.resource_policy USING btree (policy_id);


--
-- Name: idx_res_scope_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_res_scope_scope ON public.resource_scope USING btree (scope_id);


--
-- Name: idx_res_serv_pol_res_serv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_res_serv_pol_res_serv ON public.resource_server_policy USING btree (resource_server_id);


--
-- Name: idx_res_srv_res_res_srv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_res_srv_res_res_srv ON public.resource_server_resource USING btree (resource_server_id);


--
-- Name: idx_res_srv_scope_res_srv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_res_srv_scope_res_srv ON public.resource_server_scope USING btree (resource_server_id);


--
-- Name: idx_rev_token_on_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rev_token_on_expire ON public.revoked_token USING btree (expire);


--
-- Name: idx_rewards_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rewards_created_at ON public.rewards USING btree (created_at);


--
-- Name: idx_rewards_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rewards_customer_id ON public.rewards USING btree (customer_id);


--
-- Name: idx_rewards_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rewards_job_id ON public.rewards USING btree (job_id);


--
-- Name: idx_rewards_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rewards_status ON public.rewards USING btree (status);


--
-- Name: idx_rewards_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rewards_type ON public.rewards USING btree (type);


--
-- Name: idx_role_attribute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_attribute ON public.role_attribute USING btree (role_id);


--
-- Name: idx_role_clscope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_clscope ON public.client_scope_role_mapping USING btree (role_id);


--
-- Name: idx_role_configs_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_configs_company ON public.company_role_configs USING btree (company_id);


--
-- Name: idx_role_permissions_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_config ON public.company_role_permissions USING btree (role_config_id);


--
-- Name: idx_role_scopes_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_scopes_config ON public.company_role_scopes USING btree (role_config_id);


--
-- Name: idx_scope_mapping_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scope_mapping_role ON public.scope_mapping USING btree (role_id);


--
-- Name: idx_scope_policy_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scope_policy_policy ON public.scope_policy USING btree (policy_id);


--
-- Name: idx_service_territories_area; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_service_territories_area ON public.service_territories USING btree (company_id, area);


--
-- Name: idx_sms_conv_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_company ON public.sms_conversations USING btree (company_id);


--
-- Name: idx_sms_conv_customer_digits; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_customer_digits ON public.sms_conversations USING btree (customer_digits);


--
-- Name: idx_sms_conv_customer_proxy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_customer_proxy ON public.sms_conversations USING btree (customer_e164, proxy_e164);


--
-- Name: idx_sms_conv_last_message_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_last_message_at ON public.sms_conversations USING btree (last_message_at DESC);


--
-- Name: idx_sms_conv_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_state ON public.sms_conversations USING btree (state);


--
-- Name: idx_sms_conv_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_unread ON public.sms_conversations USING btree (has_unread, last_message_at DESC);


--
-- Name: idx_sms_events_conv_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_events_conv_sid ON public.sms_events USING btree (conversation_sid);


--
-- Name: idx_sms_events_msg_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_events_msg_sid ON public.sms_events USING btree (message_sid);


--
-- Name: idx_sms_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_events_status ON public.sms_events USING btree (processing_status, received_at DESC);


--
-- Name: idx_sms_media_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_media_expires ON public.sms_media USING btree (temporary_url_expires_at);


--
-- Name: idx_sms_media_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_media_message ON public.sms_media USING btree (message_id);


--
-- Name: idx_sms_msg_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_author ON public.sms_messages USING btree (author);


--
-- Name: idx_sms_msg_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_conversation_created ON public.sms_messages USING btree (conversation_id, created_at);


--
-- Name: idx_sms_msg_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_delivery_status ON public.sms_messages USING btree (delivery_status);


--
-- Name: idx_targets_metric_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targets_metric_type ON public.targets USING btree (metric_type);


--
-- Name: idx_targets_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targets_month ON public.targets USING btree (month);


--
-- Name: idx_tasks_assigned_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_assigned_provider ON public.tasks USING btree (assigned_provider_id) WHERE (assigned_provider_id IS NOT NULL);


--
-- Name: idx_tasks_company_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_company_status ON public.tasks USING btree (company_id, status, due_at);


--
-- Name: idx_tasks_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_schedule ON public.tasks USING btree (company_id, start_at, end_at) WHERE (show_on_schedule = true);


--
-- Name: idx_tasks_thread_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_thread_status ON public.tasks USING btree (thread_id, status);


--
-- Name: idx_timelines_action_required; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timelines_action_required ON public.timelines USING btree (is_action_required, snoozed_until, action_required_set_at DESC) WHERE (is_action_required = true);


--
-- Name: idx_timelines_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timelines_contact_id ON public.timelines USING btree (contact_id);


--
-- Name: idx_timelines_orphan_phone_digits; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timelines_orphan_phone_digits ON public.timelines USING btree ("right"(regexp_replace(phone_e164, '[^0-9]'::text, ''::text, 'g'::text), 10)) WHERE ((contact_id IS NULL) AND (phone_e164 IS NOT NULL));


--
-- Name: idx_timelines_snoozed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timelines_snoozed ON public.timelines USING btree (snoozed_until) WHERE ((snoozed_until IS NOT NULL) AND (is_action_required = true));


--
-- Name: idx_transcripts_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_call ON public.transcripts USING btree (call_sid);


--
-- Name: idx_transcripts_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_company_id ON public.transcripts USING btree (company_id);


--
-- Name: idx_transcripts_recording; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_recording ON public.transcripts USING btree (recording_sid);


--
-- Name: idx_transcripts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_status ON public.transcripts USING btree (status, updated_at DESC);


--
-- Name: idx_update_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_update_time ON public.migration_model USING btree (update_time);


--
-- Name: idx_usconsent_clscope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usconsent_clscope ON public.user_consent_client_scope USING btree (user_consent_id);


--
-- Name: idx_usconsent_scope_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usconsent_scope_id ON public.user_consent_client_scope USING btree (scope_id);


--
-- Name: idx_user_attribute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_attribute ON public.user_attribute USING btree (user_id);


--
-- Name: idx_user_attribute_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_attribute_name ON public.user_attribute USING btree (name, value);


--
-- Name: idx_user_consent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_consent ON public.user_consent USING btree (user_id);


--
-- Name: idx_user_credential; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_credential ON public.credential USING btree (user_id);


--
-- Name: idx_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_email ON public.user_entity USING btree (email);


--
-- Name: idx_user_group_mapping; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_group_mapping ON public.user_group_membership USING btree (user_id);


--
-- Name: idx_user_groups_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_groups_company ON public.user_groups USING btree (company_id);


--
-- Name: idx_user_profiles_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_membership ON public.company_user_profiles USING btree (membership_id);


--
-- Name: idx_user_reqactions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_reqactions ON public.user_required_action USING btree (user_id);


--
-- Name: idx_user_role_mapping; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_mapping ON public.user_role_mapping USING btree (user_id);


--
-- Name: idx_user_service_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_service_account ON public.user_entity USING btree (realm_id, service_account_client_link);


--
-- Name: idx_user_service_areas_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_service_areas_membership ON public.company_user_service_areas USING btree (membership_id);


--
-- Name: idx_user_skills_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_skills_membership ON public.company_user_skills USING btree (membership_id);


--
-- Name: idx_usr_fed_map_fed_prv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usr_fed_map_fed_prv ON public.user_federation_mapper USING btree (federation_provider_id);


--
-- Name: idx_usr_fed_map_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usr_fed_map_realm ON public.user_federation_mapper USING btree (realm_id);


--
-- Name: idx_usr_fed_prv_realm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usr_fed_prv_realm ON public.user_federation_provider USING btree (realm_id);


--
-- Name: idx_web_orig_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_web_orig_client ON public.web_origins USING btree (client_id);


--
-- Name: idx_webhook_inbox_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_inbox_company_id ON public.webhook_inbox USING btree (company_id);


--
-- Name: idx_zb_payments_company_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zb_payments_company_date ON public.zb_payments USING btree (company_id, payment_date DESC);


--
-- Name: idx_zb_payments_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zb_payments_company_id ON public.zb_payments USING btree (company_id);


--
-- Name: idx_zb_payments_payment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zb_payments_payment_date ON public.zb_payments USING btree (payment_date DESC);


--
-- Name: idx_zb_payments_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zb_payments_transaction_id ON public.zb_payments USING btree (transaction_id);


--
-- Name: job_tags_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_tags_name_active ON public.job_tags USING btree (lower((name)::text)) WHERE (is_active = true);


--
-- Name: uniq_email_mailbox_company_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_mailbox_company_provider ON public.email_mailboxes USING btree (company_id, provider);


--
-- Name: uniq_email_message_company_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_message_company_provider ON public.email_messages USING btree (company_id, provider_message_id);


--
-- Name: uniq_email_thread_company_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_email_thread_company_provider ON public.email_threads USING btree (company_id, provider_thread_id);


--
-- Name: uniq_sms_active_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_sms_active_pair ON public.sms_conversations USING btree (customer_e164, proxy_e164) WHERE ((state = 'active'::text) AND (customer_e164 IS NOT NULL) AND (proxy_e164 IS NOT NULL));


--
-- Name: uniq_sms_events_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_sms_events_idempotency ON public.sms_events USING btree (idempotency_key);


--
-- Name: uq_call_flow_executions_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_call_flow_executions_call_sid ON public.call_flow_executions USING btree (call_sid);


--
-- Name: uq_contact_addr_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contact_addr_hash ON public.contact_addresses USING btree (contact_id, address_normalized_hash) WHERE (address_normalized_hash IS NOT NULL);


--
-- Name: uq_contact_addr_place_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contact_addr_place_id ON public.contact_addresses USING btree (contact_id, google_place_id) WHERE (google_place_id IS NOT NULL);


--
-- Name: uq_group_hours_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_group_hours_day ON public.user_group_hours USING btree (group_id, day_of_week);


--
-- Name: uq_group_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_group_member ON public.user_group_members USING btree (group_id, user_id);


--
-- Name: uq_group_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_group_number ON public.user_group_numbers USING btree (group_id, phone_number);


--
-- Name: uq_tasks_one_open_per_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tasks_one_open_per_thread ON public.tasks USING btree (thread_id) WHERE (status = 'open'::text);


--
-- Name: uq_timelines_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_timelines_contact ON public.timelines USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: uq_timelines_orphan_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_timelines_orphan_phone ON public.timelines USING btree (phone_e164) WHERE ((phone_e164 IS NOT NULL) AND (contact_id IS NULL));


--
-- Name: user_attr_long_values; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_attr_long_values ON public.user_attribute USING btree (long_value_hash, name);


--
-- Name: user_attr_long_values_lower_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_attr_long_values_lower_case ON public.user_attribute USING btree (long_value_hash_lower_case, name);


--
-- Name: call_flow_executions trg_call_flow_executions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_call_flow_executions_updated_at BEFORE UPDATE ON public.call_flow_executions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: call_flows trg_call_flows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_call_flows_updated_at BEFORE UPDATE ON public.call_flows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: calls trg_calls_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_calls_updated_at BEFORE UPDATE ON public.calls FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: contacts trg_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: dispatch_settings trg_dispatch_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dispatch_settings_updated_at BEFORE UPDATE ON public.dispatch_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: document_deliveries trg_document_deliveries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_deliveries_updated_at BEFORE UPDATE ON public.document_deliveries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_mailboxes trg_email_mailboxes_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_mailboxes_updated BEFORE UPDATE ON public.email_mailboxes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_messages trg_email_messages_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_messages_updated BEFORE UPDATE ON public.email_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_sync_state trg_email_sync_state_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_sync_state_updated BEFORE UPDATE ON public.email_sync_state FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_threads trg_email_threads_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_threads_updated BEFORE UPDATE ON public.email_threads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: estimate_items trg_estimate_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_estimate_items_updated_at BEFORE UPDATE ON public.estimate_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: estimates trg_estimates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_estimates_updated_at BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_invitations trg_invitations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invitations_updated_at BEFORE UPDATE ON public.company_invitations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: invoice_items trg_invoice_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoice_items_updated_at BEFORE UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: invoices trg_invoices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: jobs trg_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: leads trg_leads_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: marketplace_apps trg_marketplace_apps_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marketplace_apps_updated_at BEFORE UPDATE ON public.marketplace_apps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: marketplace_installations trg_marketplace_installations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marketplace_installations_updated_at BEFORE UPDATE ON public.marketplace_installations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_membership_permission_overrides trg_membership_perm_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_membership_perm_overrides_updated_at BEFORE UPDATE ON public.company_membership_permission_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_membership_scope_overrides trg_membership_scope_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_membership_scope_overrides_updated_at BEFORE UPDATE ON public.company_membership_scope_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: payment_transactions trg_payment_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_transactions_updated_at BEFORE UPDATE ON public.payment_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: phone_number_settings trg_phone_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_phone_settings_updated_at BEFORE UPDATE ON public.phone_number_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recordings trg_recordings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recordings_updated_at BEFORE UPDATE ON public.recordings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_role_configs trg_role_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_configs_updated_at BEFORE UPDATE ON public.company_role_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_role_permissions trg_role_permissions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_permissions_updated_at BEFORE UPDATE ON public.company_role_permissions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_role_scopes trg_role_scopes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_role_scopes_updated_at BEFORE UPDATE ON public.company_role_scopes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: sms_conversations trg_sms_conv_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sms_conv_updated BEFORE UPDATE ON public.sms_conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: sms_media trg_sms_media_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sms_media_updated BEFORE UPDATE ON public.sms_media FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: sms_messages trg_sms_msg_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sms_msg_updated BEFORE UPDATE ON public.sms_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: sms_conversations trg_sms_update_timeline; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sms_update_timeline AFTER INSERT OR UPDATE OF last_message_at ON public.sms_conversations FOR EACH ROW EXECUTE FUNCTION public.fn_update_timeline_sms_last_at();


--
-- Name: transcripts trg_transcripts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_transcripts_updated_at BEFORE UPDATE ON public.transcripts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_groups trg_user_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_groups_updated_at BEFORE UPDATE ON public.user_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: company_user_profiles trg_user_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON public.company_user_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: zb_payments trg_zb_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zb_payments_updated_at BEFORE UPDATE ON public.zb_payments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: api_integrations api_integrations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations
    ADD CONSTRAINT api_integrations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: api_integrations api_integrations_marketplace_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations
    ADD CONSTRAINT api_integrations_marketplace_app_id_fkey FOREIGN KEY (marketplace_app_id) REFERENCES public.marketplace_apps(id) ON DELETE SET NULL;


--
-- Name: api_integrations api_integrations_marketplace_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_integrations
    ADD CONSTRAINT api_integrations_marketplace_installation_id_fkey FOREIGN KEY (marketplace_installation_id) REFERENCES public.marketplace_installations(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: call_events call_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: call_flow_executions call_flow_executions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_flow_executions
    ADD CONSTRAINT call_flow_executions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE SET NULL;


--
-- Name: call_flows call_flows_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_flows
    ADD CONSTRAINT call_flows_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE SET NULL;


--
-- Name: calls calls_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: calls calls_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: calls calls_timeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_timeline_id_fkey FOREIGN KEY (timeline_id) REFERENCES public.timelines(id);


--
-- Name: companies companies_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.crm_users(id);


--
-- Name: company_invitations company_invitations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invitations
    ADD CONSTRAINT company_invitations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_invitations company_invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invitations
    ADD CONSTRAINT company_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.crm_users(id);


--
-- Name: company_membership_permission_overrides company_membership_permission_overrides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_permission_overrides
    ADD CONSTRAINT company_membership_permission_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id);


--
-- Name: company_membership_permission_overrides company_membership_permission_overrides_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_permission_overrides
    ADD CONSTRAINT company_membership_permission_overrides_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.company_memberships(id) ON DELETE CASCADE;


--
-- Name: company_membership_scope_overrides company_membership_scope_overrides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_scope_overrides
    ADD CONSTRAINT company_membership_scope_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id);


--
-- Name: company_membership_scope_overrides company_membership_scope_overrides_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_membership_scope_overrides
    ADD CONSTRAINT company_membership_scope_overrides_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.company_memberships(id) ON DELETE CASCADE;


--
-- Name: company_memberships company_memberships_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_memberships company_memberships_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.crm_users(id);


--
-- Name: company_memberships company_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.crm_users(id) ON DELETE CASCADE;


--
-- Name: company_role_configs company_role_configs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_configs
    ADD CONSTRAINT company_role_configs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_role_configs company_role_configs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_configs
    ADD CONSTRAINT company_role_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id);


--
-- Name: company_role_permissions company_role_permissions_role_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_permissions
    ADD CONSTRAINT company_role_permissions_role_config_id_fkey FOREIGN KEY (role_config_id) REFERENCES public.company_role_configs(id) ON DELETE CASCADE;


--
-- Name: company_role_scopes company_role_scopes_role_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_role_scopes
    ADD CONSTRAINT company_role_scopes_role_config_id_fkey FOREIGN KEY (role_config_id) REFERENCES public.company_role_configs(id) ON DELETE CASCADE;


--
-- Name: company_user_profiles company_user_profiles_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_profiles
    ADD CONSTRAINT company_user_profiles_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.company_memberships(id) ON DELETE CASCADE;


--
-- Name: company_user_service_areas company_user_service_areas_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_service_areas
    ADD CONSTRAINT company_user_service_areas_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.company_memberships(id) ON DELETE CASCADE;


--
-- Name: company_user_skills company_user_skills_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_user_skills
    ADD CONSTRAINT company_user_skills_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES public.company_memberships(id) ON DELETE CASCADE;


--
-- Name: contact_addresses contact_addresses_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_addresses
    ADD CONSTRAINT contact_addresses_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_emails contact_emails_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_emails
    ADD CONSTRAINT contact_emails_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: crm_users crm_users_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_users
    ADD CONSTRAINT crm_users_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: dispatch_settings dispatch_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_settings
    ADD CONSTRAINT dispatch_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: document_attachments document_attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: document_attachments document_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: document_deliveries document_deliveries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_deliveries
    ADD CONSTRAINT document_deliveries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: document_deliveries document_deliveries_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_deliveries
    ADD CONSTRAINT document_deliveries_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: document_delivery_attachments document_delivery_attachments_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_delivery_attachments
    ADD CONSTRAINT document_delivery_attachments_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.document_attachments(id) ON DELETE CASCADE;


--
-- Name: document_delivery_attachments document_delivery_attachments_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_delivery_attachments
    ADD CONSTRAINT document_delivery_attachments_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.document_deliveries(id) ON DELETE CASCADE;


--
-- Name: domain_events domain_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_attachments email_attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_attachments
    ADD CONSTRAINT email_attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_attachments email_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_attachments
    ADD CONSTRAINT email_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.email_messages(id) ON DELETE CASCADE;


--
-- Name: email_mailboxes email_mailboxes_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_mailboxes
    ADD CONSTRAINT email_mailboxes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_messages email_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_messages email_messages_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.email_mailboxes(id) ON DELETE CASCADE;


--
-- Name: email_messages email_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.email_threads(id) ON DELETE CASCADE;


--
-- Name: email_sync_state email_sync_state_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_state
    ADD CONSTRAINT email_sync_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_sync_state email_sync_state_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_state
    ADD CONSTRAINT email_sync_state_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.email_mailboxes(id) ON DELETE CASCADE;


--
-- Name: email_threads email_threads_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: email_threads email_threads_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.email_mailboxes(id) ON DELETE CASCADE;


--
-- Name: estimate_events estimate_events_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_events
    ADD CONSTRAINT estimate_events_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: estimate_items estimate_items_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_items
    ADD CONSTRAINT estimate_items_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: estimate_revisions estimate_revisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_revisions
    ADD CONSTRAINT estimate_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: estimate_revisions estimate_revisions_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimate_revisions
    ADD CONSTRAINT estimate_revisions_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE CASCADE;


--
-- Name: estimates estimates_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: estimates estimates_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: estimates estimates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimates
    ADD CONSTRAINT estimates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: fact_expense fact_expense_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_expense
    ADD CONSTRAINT fact_expense_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.dim_source(id);


--
-- Name: fact_expense fact_expense_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_expense
    ADD CONSTRAINT fact_expense_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.fact_jobs(job_id);


--
-- Name: fact_jobs fact_jobs_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_jobs
    ADD CONSTRAINT fact_jobs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.fact_leads(lead_id);


--
-- Name: fact_jobs fact_jobs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_jobs
    ADD CONSTRAINT fact_jobs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.dim_source(id);


--
-- Name: fact_leads fact_leads_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_leads
    ADD CONSTRAINT fact_leads_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.dim_source(id);


--
-- Name: fact_parts fact_parts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_parts
    ADD CONSTRAINT fact_parts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.fact_jobs(job_id);


--
-- Name: fact_payments fact_payments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_payments
    ADD CONSTRAINT fact_payments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.fact_jobs(job_id);


--
-- Name: identity_provider fk2b4ebc52ae5c3b34; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider
    ADD CONSTRAINT fk2b4ebc52ae5c3b34 FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: client_attributes fk3c47c64beacca966; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_attributes
    ADD CONSTRAINT fk3c47c64beacca966 FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: federated_identity fk404288b92ef007a6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_identity
    ADD CONSTRAINT fk404288b92ef007a6 FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: client_node_registrations fk4129723ba992f594; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_node_registrations
    ADD CONSTRAINT fk4129723ba992f594 FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: redirect_uris fk_1burs8pb4ouj97h5wuppahv9f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redirect_uris
    ADD CONSTRAINT fk_1burs8pb4ouj97h5wuppahv9f FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: user_federation_provider fk_1fj32f6ptolw2qy60cd8n01e8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_provider
    ADD CONSTRAINT fk_1fj32f6ptolw2qy60cd8n01e8 FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: realm_required_credential fk_5hg65lybevavkqfki3kponh9v; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_required_credential
    ADD CONSTRAINT fk_5hg65lybevavkqfki3kponh9v FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: resource_attribute fk_5hrm2vlf9ql5fu022kqepovbr; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_attribute
    ADD CONSTRAINT fk_5hrm2vlf9ql5fu022kqepovbr FOREIGN KEY (resource_id) REFERENCES public.resource_server_resource(id);


--
-- Name: user_attribute fk_5hrm2vlf9ql5fu043kqepovbr; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attribute
    ADD CONSTRAINT fk_5hrm2vlf9ql5fu043kqepovbr FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: user_required_action fk_6qj3w1jw9cvafhe19bwsiuvmd; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_required_action
    ADD CONSTRAINT fk_6qj3w1jw9cvafhe19bwsiuvmd FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: keycloak_role fk_6vyqfe4cn4wlq8r6kt5vdsj5c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keycloak_role
    ADD CONSTRAINT fk_6vyqfe4cn4wlq8r6kt5vdsj5c FOREIGN KEY (realm) REFERENCES public.realm(id);


--
-- Name: realm_smtp_config fk_70ej8xdxgxd0b9hh6180irr0o; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_smtp_config
    ADD CONSTRAINT fk_70ej8xdxgxd0b9hh6180irr0o FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: realm_attribute fk_8shxd6l3e9atqukacxgpffptw; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_attribute
    ADD CONSTRAINT fk_8shxd6l3e9atqukacxgpffptw FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: composite_role fk_a63wvekftu8jo1pnj81e7mce2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.composite_role
    ADD CONSTRAINT fk_a63wvekftu8jo1pnj81e7mce2 FOREIGN KEY (composite) REFERENCES public.keycloak_role(id);


--
-- Name: authentication_execution fk_auth_exec_flow; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication_execution
    ADD CONSTRAINT fk_auth_exec_flow FOREIGN KEY (flow_id) REFERENCES public.authentication_flow(id);


--
-- Name: authentication_execution fk_auth_exec_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication_execution
    ADD CONSTRAINT fk_auth_exec_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: authentication_flow fk_auth_flow_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authentication_flow
    ADD CONSTRAINT fk_auth_flow_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: authenticator_config fk_auth_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authenticator_config
    ADD CONSTRAINT fk_auth_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: user_role_mapping fk_c4fqv34p1mbylloxang7b1q3l; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_mapping
    ADD CONSTRAINT fk_c4fqv34p1mbylloxang7b1q3l FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: client_scope_attributes fk_cl_scope_attr_scope; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope_attributes
    ADD CONSTRAINT fk_cl_scope_attr_scope FOREIGN KEY (scope_id) REFERENCES public.client_scope(id);


--
-- Name: client_scope_role_mapping fk_cl_scope_rm_scope; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_scope_role_mapping
    ADD CONSTRAINT fk_cl_scope_rm_scope FOREIGN KEY (scope_id) REFERENCES public.client_scope(id);


--
-- Name: protocol_mapper fk_cli_scope_mapper; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_mapper
    ADD CONSTRAINT fk_cli_scope_mapper FOREIGN KEY (client_scope_id) REFERENCES public.client_scope(id);


--
-- Name: client_initial_access fk_client_init_acc_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_initial_access
    ADD CONSTRAINT fk_client_init_acc_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: component_config fk_component_config; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component_config
    ADD CONSTRAINT fk_component_config FOREIGN KEY (component_id) REFERENCES public.component(id);


--
-- Name: component fk_component_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.component
    ADD CONSTRAINT fk_component_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: crm_users fk_crm_users_primary_membership; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_users
    ADD CONSTRAINT fk_crm_users_primary_membership FOREIGN KEY (primary_membership_id) REFERENCES public.company_memberships(id);


--
-- Name: realm_default_groups fk_def_groups_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_default_groups
    ADD CONSTRAINT fk_def_groups_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: user_federation_mapper_config fk_fedmapper_cfg; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_mapper_config
    ADD CONSTRAINT fk_fedmapper_cfg FOREIGN KEY (user_federation_mapper_id) REFERENCES public.user_federation_mapper(id);


--
-- Name: user_federation_mapper fk_fedmapperpm_fedprv; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_mapper
    ADD CONSTRAINT fk_fedmapperpm_fedprv FOREIGN KEY (federation_provider_id) REFERENCES public.user_federation_provider(id);


--
-- Name: user_federation_mapper fk_fedmapperpm_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_mapper
    ADD CONSTRAINT fk_fedmapperpm_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: associated_policy fk_frsr5s213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.associated_policy
    ADD CONSTRAINT fk_frsr5s213xcx4wnkog82ssrfy FOREIGN KEY (associated_policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: scope_policy fk_frsrasp13xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_policy
    ADD CONSTRAINT fk_frsrasp13xcx4wnkog82ssrfy FOREIGN KEY (policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: resource_server_perm_ticket fk_frsrho213xcx4wnkog82sspmt; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT fk_frsrho213xcx4wnkog82sspmt FOREIGN KEY (resource_server_id) REFERENCES public.resource_server(id);


--
-- Name: resource_server_resource fk_frsrho213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_resource
    ADD CONSTRAINT fk_frsrho213xcx4wnkog82ssrfy FOREIGN KEY (resource_server_id) REFERENCES public.resource_server(id);


--
-- Name: resource_server_perm_ticket fk_frsrho213xcx4wnkog83sspmt; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT fk_frsrho213xcx4wnkog83sspmt FOREIGN KEY (resource_id) REFERENCES public.resource_server_resource(id);


--
-- Name: resource_server_perm_ticket fk_frsrho213xcx4wnkog84sspmt; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT fk_frsrho213xcx4wnkog84sspmt FOREIGN KEY (scope_id) REFERENCES public.resource_server_scope(id);


--
-- Name: associated_policy fk_frsrpas14xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.associated_policy
    ADD CONSTRAINT fk_frsrpas14xcx4wnkog82ssrfy FOREIGN KEY (policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: scope_policy fk_frsrpass3xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_policy
    ADD CONSTRAINT fk_frsrpass3xcx4wnkog82ssrfy FOREIGN KEY (scope_id) REFERENCES public.resource_server_scope(id);


--
-- Name: resource_server_perm_ticket fk_frsrpo2128cx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_perm_ticket
    ADD CONSTRAINT fk_frsrpo2128cx4wnkog82ssrfy FOREIGN KEY (policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: resource_server_policy fk_frsrpo213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_policy
    ADD CONSTRAINT fk_frsrpo213xcx4wnkog82ssrfy FOREIGN KEY (resource_server_id) REFERENCES public.resource_server(id);


--
-- Name: resource_scope fk_frsrpos13xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_scope
    ADD CONSTRAINT fk_frsrpos13xcx4wnkog82ssrfy FOREIGN KEY (resource_id) REFERENCES public.resource_server_resource(id);


--
-- Name: resource_policy fk_frsrpos53xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_policy
    ADD CONSTRAINT fk_frsrpos53xcx4wnkog82ssrfy FOREIGN KEY (resource_id) REFERENCES public.resource_server_resource(id);


--
-- Name: resource_policy fk_frsrpp213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_policy
    ADD CONSTRAINT fk_frsrpp213xcx4wnkog82ssrfy FOREIGN KEY (policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: resource_scope fk_frsrps213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_scope
    ADD CONSTRAINT fk_frsrps213xcx4wnkog82ssrfy FOREIGN KEY (scope_id) REFERENCES public.resource_server_scope(id);


--
-- Name: resource_server_scope fk_frsrso213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_server_scope
    ADD CONSTRAINT fk_frsrso213xcx4wnkog82ssrfy FOREIGN KEY (resource_server_id) REFERENCES public.resource_server(id);


--
-- Name: fsm_machines fk_fsm_machines_active_version; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_machines
    ADD CONSTRAINT fk_fsm_machines_active_version FOREIGN KEY (active_version_id) REFERENCES public.fsm_versions(id);


--
-- Name: composite_role fk_gr7thllb9lu8q4vqa4524jjy8; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.composite_role
    ADD CONSTRAINT fk_gr7thllb9lu8q4vqa4524jjy8 FOREIGN KEY (child_role) REFERENCES public.keycloak_role(id);


--
-- Name: user_consent_client_scope fk_grntcsnt_clsc_usc; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent_client_scope
    ADD CONSTRAINT fk_grntcsnt_clsc_usc FOREIGN KEY (user_consent_id) REFERENCES public.user_consent(id);


--
-- Name: user_consent fk_grntcsnt_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_consent
    ADD CONSTRAINT fk_grntcsnt_user FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: group_attribute fk_group_attribute_group; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_attribute
    ADD CONSTRAINT fk_group_attribute_group FOREIGN KEY (group_id) REFERENCES public.keycloak_group(id);


--
-- Name: group_role_mapping fk_group_role_group; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_role_mapping
    ADD CONSTRAINT fk_group_role_group FOREIGN KEY (group_id) REFERENCES public.keycloak_group(id);


--
-- Name: realm_enabled_event_types fk_h846o4h0w8epx5nwedrf5y69j; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_enabled_event_types
    ADD CONSTRAINT fk_h846o4h0w8epx5nwedrf5y69j FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: realm_events_listeners fk_h846o4h0w8epx5nxev9f5y69j; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_events_listeners
    ADD CONSTRAINT fk_h846o4h0w8epx5nxev9f5y69j FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: identity_provider_mapper fk_idpm_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider_mapper
    ADD CONSTRAINT fk_idpm_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: idp_mapper_config fk_idpmconfig; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_mapper_config
    ADD CONSTRAINT fk_idpmconfig FOREIGN KEY (idp_mapper_id) REFERENCES public.identity_provider_mapper(id);


--
-- Name: web_origins fk_lojpho213xcx4wnkog82ssrfy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_origins
    ADD CONSTRAINT fk_lojpho213xcx4wnkog82ssrfy FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: scope_mapping fk_ouse064plmlr732lxjcn1q5f1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scope_mapping
    ADD CONSTRAINT fk_ouse064plmlr732lxjcn1q5f1 FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: protocol_mapper fk_pcm_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_mapper
    ADD CONSTRAINT fk_pcm_realm FOREIGN KEY (client_id) REFERENCES public.client(id);


--
-- Name: credential fk_pfyr0glasqyl0dei3kl69r6v0; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential
    ADD CONSTRAINT fk_pfyr0glasqyl0dei3kl69r6v0 FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: protocol_mapper_config fk_pmconfig; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protocol_mapper_config
    ADD CONSTRAINT fk_pmconfig FOREIGN KEY (protocol_mapper_id) REFERENCES public.protocol_mapper(id);


--
-- Name: default_client_scope fk_r_def_cli_scope_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.default_client_scope
    ADD CONSTRAINT fk_r_def_cli_scope_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: referral_shares fk_referral_link; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_shares
    ADD CONSTRAINT fk_referral_link FOREIGN KEY (referral_link_id) REFERENCES public.referral_links(id) ON DELETE CASCADE;


--
-- Name: required_action_provider fk_req_act_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.required_action_provider
    ADD CONSTRAINT fk_req_act_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: resource_uris fk_resource_server_uris; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_uris
    ADD CONSTRAINT fk_resource_server_uris FOREIGN KEY (resource_id) REFERENCES public.resource_server_resource(id);


--
-- Name: role_attribute fk_role_attribute_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_attribute
    ADD CONSTRAINT fk_role_attribute_id FOREIGN KEY (role_id) REFERENCES public.keycloak_role(id);


--
-- Name: realm_supported_locales fk_supported_locales_realm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realm_supported_locales
    ADD CONSTRAINT fk_supported_locales_realm FOREIGN KEY (realm_id) REFERENCES public.realm(id);


--
-- Name: user_federation_config fk_t13hpu1j94r2ebpekr39x5eu5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federation_config
    ADD CONSTRAINT fk_t13hpu1j94r2ebpekr39x5eu5 FOREIGN KEY (user_federation_provider_id) REFERENCES public.user_federation_provider(id);


--
-- Name: user_group_membership fk_user_group_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_membership
    ADD CONSTRAINT fk_user_group_user FOREIGN KEY (user_id) REFERENCES public.user_entity(id);


--
-- Name: policy_config fkdc34197cf864c4e43; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_config
    ADD CONSTRAINT fkdc34197cf864c4e43 FOREIGN KEY (policy_id) REFERENCES public.resource_server_policy(id);


--
-- Name: identity_provider_config fkdc4897cf864c4e43; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_provider_config
    ADD CONSTRAINT fkdc4897cf864c4e43 FOREIGN KEY (identity_provider_id) REFERENCES public.identity_provider(internal_id);


--
-- Name: fsm_machines fsm_machines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_machines
    ADD CONSTRAINT fsm_machines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: fsm_versions fsm_versions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_versions
    ADD CONSTRAINT fsm_versions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: fsm_versions fsm_versions_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fsm_versions
    ADD CONSTRAINT fsm_versions_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.fsm_machines(id) ON DELETE CASCADE;


--
-- Name: invoice_events invoice_events_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_events
    ADD CONSTRAINT invoice_events_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_revisions invoice_revisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_revisions
    ADD CONSTRAINT invoice_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: invoice_revisions invoice_revisions_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_revisions
    ADD CONSTRAINT invoice_revisions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: job_tag_assignments job_tag_assignments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tag_assignments
    ADD CONSTRAINT job_tag_assignments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_tag_assignments job_tag_assignments_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_tag_assignments
    ADD CONSTRAINT job_tag_assignments_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.job_tags(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: jobs jobs_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: lead_custom_fields lead_custom_fields_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_custom_fields
    ADD CONSTRAINT lead_custom_fields_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: lead_job_types lead_job_types_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_job_types
    ADD CONSTRAINT lead_job_types_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: lead_team_assignments lead_team_assignments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_team_assignments
    ADD CONSTRAINT lead_team_assignments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: lead_team_assignments lead_team_assignments_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_team_assignments
    ADD CONSTRAINT lead_team_assignments_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;


--
-- Name: leads leads_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: leads leads_contact_address_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_contact_address_id_fkey FOREIGN KEY (contact_address_id) REFERENCES public.contact_addresses(id) ON DELETE SET NULL;


--
-- Name: leads leads_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: marketplace_installation_events marketplace_installation_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: marketplace_installation_events marketplace_installation_events_api_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_api_integration_id_fkey FOREIGN KEY (api_integration_id) REFERENCES public.api_integrations(id) ON DELETE SET NULL;


--
-- Name: marketplace_installation_events marketplace_installation_events_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.marketplace_apps(id) ON DELETE SET NULL;


--
-- Name: marketplace_installation_events marketplace_installation_events_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: marketplace_installation_events marketplace_installation_events_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installation_events
    ADD CONSTRAINT marketplace_installation_events_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.marketplace_installations(id) ON DELETE SET NULL;


--
-- Name: marketplace_installations marketplace_installations_api_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_api_integration_id_fkey FOREIGN KEY (api_integration_id) REFERENCES public.api_integrations(id) ON DELETE SET NULL;


--
-- Name: marketplace_installations marketplace_installations_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.marketplace_apps(id) ON DELETE RESTRICT;


--
-- Name: marketplace_installations marketplace_installations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: marketplace_installations marketplace_installations_disconnected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_disconnected_by_fkey FOREIGN KEY (disconnected_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: marketplace_installations marketplace_installations_installed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_installations
    ADD CONSTRAINT marketplace_installations_installed_by_fkey FOREIGN KEY (installed_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: note_attachments note_attachments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_attachments
    ADD CONSTRAINT note_attachments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: note_attachments note_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_attachments
    ADD CONSTRAINT note_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: payment_receipts payment_receipts_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_receipts
    ADD CONSTRAINT payment_receipts_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.payment_transactions(id) ON DELETE CASCADE;


--
-- Name: payment_transactions payment_transactions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payment_transactions payment_transactions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: payment_transactions payment_transactions_estimate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES public.estimates(id) ON DELETE SET NULL;


--
-- Name: payment_transactions payment_transactions_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: payment_transactions payment_transactions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: payment_transactions payment_transactions_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: phone_number_settings phone_number_settings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_number_settings
    ADD CONSTRAINT phone_number_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: phone_number_settings phone_number_settings_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_number_settings
    ADD CONSTRAINT phone_number_settings_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE SET NULL;


--
-- Name: portal_access_tokens portal_access_tokens_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_tokens
    ADD CONSTRAINT portal_access_tokens_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: portal_access_tokens portal_access_tokens_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_tokens
    ADD CONSTRAINT portal_access_tokens_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_access_tokens portal_access_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_access_tokens
    ADD CONSTRAINT portal_access_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: portal_events portal_events_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: portal_events portal_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_events
    ADD CONSTRAINT portal_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.portal_sessions(id) ON DELETE CASCADE;


--
-- Name: portal_sessions portal_sessions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: portal_sessions portal_sessions_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.portal_access_tokens(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.crm_users(id) ON DELETE CASCADE;


--
-- Name: quick_messages quick_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quick_messages
    ADD CONSTRAINT quick_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: recordings recordings_call_sid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_call_sid_fkey FOREIGN KEY (call_sid) REFERENCES public.calls(call_sid);


--
-- Name: recordings recordings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: service_territories service_territories_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_territories
    ADD CONSTRAINT service_territories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: sms_conversations sms_conversations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversations
    ADD CONSTRAINT sms_conversations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: sms_media sms_media_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_media
    ADD CONSTRAINT sms_media_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.sms_messages(id) ON DELETE CASCADE;


--
-- Name: sms_messages sms_messages_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: sms_messages sms_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.sms_conversations(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_provider_id_fkey FOREIGN KEY (assigned_provider_id) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.timelines(id) ON DELETE CASCADE;


--
-- Name: timelines timelines_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timelines
    ADD CONSTRAINT timelines_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: timelines timelines_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timelines
    ADD CONSTRAINT timelines_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: timelines timelines_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timelines
    ADD CONSTRAINT timelines_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.crm_users(id) ON DELETE SET NULL;


--
-- Name: transcripts transcripts_call_sid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_call_sid_fkey FOREIGN KEY (call_sid) REFERENCES public.calls(call_sid);


--
-- Name: transcripts transcripts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: transcripts transcripts_recording_sid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcripts
    ADD CONSTRAINT transcripts_recording_sid_fkey FOREIGN KEY (recording_sid) REFERENCES public.recordings(recording_sid);


--
-- Name: user_group_hours user_group_hours_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_hours
    ADD CONSTRAINT user_group_hours_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE CASCADE;


--
-- Name: user_group_members user_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE CASCADE;


--
-- Name: user_group_numbers user_group_numbers_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_numbers
    ADD CONSTRAINT user_group_numbers_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE CASCADE;


--
-- Name: webhook_inbox webhook_inbox_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: zb_payments zb_payments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zb_payments
    ADD CONSTRAINT zb_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- PostgreSQL database dump complete
--

\unrestrict gi1XYJCescb8ejqvSwoorv2JZyrcXIQaoVfd54O7O8yCbeyZgQU4DIx6OTJ8VlF

