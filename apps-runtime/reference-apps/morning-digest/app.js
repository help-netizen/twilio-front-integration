function asArray(payload, key) {
    return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function firstText(record, keys, fallback) {
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number') return String(value);
    }
    return fallback;
}

function clockTime(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/(?:T|\s)(\d{2}:\d{2})/);
    return match ? match[1] : null;
}

function jobLine(job) {
    const title = firstText(
        job,
        ['service_name', 'title', 'customer_name', 'name', 'job_number'],
        `Job ${job?.id ?? ''}`.trim()
    );
    const time = clockTime(
        job?.start_date || job?.scheduled_start || job?.start_at || job?.start_time || job?.scheduled_at
    );
    const status = firstText(job, ['status', 'blanc_status'], '');
    return `- ${time ? `${time} — ` : ''}${title}${status ? ` (${status})` : ''}`;
}

function taskLine(task) {
    const title = firstText(task, ['title', 'name', 'description'], `Task ${task?.id ?? ''}`.trim());
    const due = typeof task?.due_at === 'string' ? task.due_at.slice(0, 10) : null;
    return `- ${title}${due ? ` (due ${due})` : ''}`;
}

export async function run(ctx) {
    const today = ctx?.input?.today;
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
        throw new Error('input.today must be the company-local date in YYYY-MM-DD format');
    }

    const jobsPayload = await ctx.callTool('svc.list_jobs', {
        start_date: today,
        end_date: today,
        limit: 100,
    });
    const tasksPayload = await ctx.callTool('svc.list_tasks', {
        status: 'open',
        limit: 100,
    });
    const jobs = asArray(jobsPayload, 'results');
    const tasks = asArray(tasksPayload, 'tasks');
    const lines = [`Morning digest for ${today}`];

    if (jobs.length === 0) lines.push('No jobs scheduled for today.');
    else lines.push(`Jobs today: ${jobs.length}`, ...jobs.map(jobLine));

    if (tasks.length === 0) lines.push('No open tasks.');
    else lines.push(`Open tasks: ${tasks.length}`, ...tasks.map(taskLine));

    return lines.join('\n');
}
