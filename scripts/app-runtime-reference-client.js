'use strict';

const TOOL_NAMES = new Set(['svc.list_jobs', 'svc.get_job', 'svc.list_tasks']);

function gatewayOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch (_error) {
        throw new Error('APP_RUNTIME_GATEWAY_BASE_URL must be a valid HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash) {
        throw new Error('APP_RUNTIME_GATEWAY_BASE_URL must be a valid HTTP(S) URL');
    }
    return url.origin;
}

async function callTool({ baseUrl, token, toolName, arguments: args = {}, fetchImpl = fetch }) {
    if (!TOOL_NAMES.has(toolName)) throw new Error('Unsupported reference-client tool');
    if (!token) throw new Error('APP_RUNTIME_RUN_TOKEN is required');
    const url = new URL(`/internal/app-runtime/v1/tools/${toolName}`, gatewayOrigin(baseUrl));
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) {
        throw new Error(`Gateway call failed: ${payload?.code || response.status}`);
    }
    return payload.data;
}

async function run(env = process.env, fetchImpl = fetch) {
    const baseUrl = env.APP_RUNTIME_GATEWAY_BASE_URL;
    const token = env.APP_RUNTIME_RUN_TOKEN;
    if (!baseUrl) throw new Error('APP_RUNTIME_GATEWAY_BASE_URL is required');
    if (!token) throw new Error('APP_RUNTIME_RUN_TOKEN is required');

    const jobs = await callTool({
        baseUrl,
        token,
        toolName: 'svc.list_jobs',
        arguments: { limit: 10 },
        fetchImpl,
    });
    const tasks = await callTool({
        baseUrl,
        token,
        toolName: 'svc.list_tasks',
        arguments: { limit: 10 },
        fetchImpl,
    });
    const firstJob = jobs?.results?.[0];
    if (!firstJob?.id) throw new Error('No visible Job is available for svc.get_job');
    const job = await callTool({
        baseUrl,
        token,
        toolName: 'svc.get_job',
        arguments: { job_id: Number(firstJob.id) },
        fetchImpl,
    });
    return { jobs, job, tasks };
}

if (require.main === module) {
    run()
        .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
        .catch((error) => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        });
}

module.exports = {
    TOOL_NAMES,
    gatewayOrigin,
    callTool,
    run,
};
