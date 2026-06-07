'use strict';

const dealsQueries = require('../db/crmDealsQueries');

function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
    return Math.round(value * 100) / 100;
}

function addGroup(map, key, deal) {
    const groupKey = key || 'uncategorized';
    if (!map[groupKey]) {
        map[groupKey] = { key: groupKey, count: 0, amount: 0, weighted_amount: 0, order: null, deals: [] };
    }
    const amount = asNumber(deal.amount);
    const probability = asNumber(deal.probability);
    map[groupKey].count += 1;
    map[groupKey].amount = roundMoney(map[groupKey].amount + amount);
    map[groupKey].weighted_amount = roundMoney(map[groupKey].weighted_amount + (amount * probability / 100));
    if (deal.stage_order !== undefined && deal.stage_order !== null) {
        const order = Number(deal.stage_order);
        if (Number.isFinite(order) && (map[groupKey].order === null || order < map[groupKey].order)) {
            map[groupKey].order = order;
        }
    }
    map[groupKey].deals.push(deal);
}

function sortGroups(groups) {
    return groups.sort((a, b) => {
        if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
        if (a.order !== null && b.order === null) return -1;
        if (a.order === null && b.order !== null) return 1;
        return String(a.key).localeCompare(String(b.key));
    });
}

function calculateTotals(deals) {
    const totals = {
        count: deals.length,
        pipeline: 0,
        weighted_pipeline: 0,
        commit: 0,
        best_case: 0,
        forecast_pipeline: 0,
        omitted: 0,
        forecast_categories: {
            commit: 0,
            best_case: 0,
            pipeline: 0,
            omitted: 0,
        },
    };
    for (const deal of deals) {
        const amount = asNumber(deal.amount);
        totals.pipeline = roundMoney(totals.pipeline + amount);
        totals.weighted_pipeline = roundMoney(totals.weighted_pipeline + (amount * asNumber(deal.probability) / 100));
        if (deal.forecast_category === 'commit') {
            totals.commit = roundMoney(totals.commit + amount);
            totals.forecast_categories.commit = totals.commit;
        }
        if (deal.forecast_category === 'best_case') {
            totals.best_case = roundMoney(totals.best_case + amount);
            totals.forecast_categories.best_case = totals.best_case;
        }
        if (deal.forecast_category === 'pipeline') {
            totals.forecast_pipeline = roundMoney(totals.forecast_pipeline + amount);
            totals.forecast_categories.pipeline = totals.forecast_pipeline;
        }
        if (deal.forecast_category === 'omitted') {
            totals.omitted = roundMoney(totals.omitted + amount);
            totals.forecast_categories.omitted = totals.omitted;
        }
    }
    return totals;
}

function getStageOrder(stageOrderByKey, stageKey) {
    if (!stageKey || !stageOrderByKey) return null;
    const order = stageOrderByKey[String(stageKey)];
    return Number.isFinite(Number(order)) ? Number(order) : null;
}

function summarizeChanges(historyRows) {
    const summary = {
        event_count: historyRows.length,
        field_counts: {},
        amount_delta: 0,
        close_date_pushes: 0,
        amount_decreases: 0,
        stage_changes: 0,
    };
    for (const row of historyRows) {
        summary.field_counts[row.field_name] = (summary.field_counts[row.field_name] || 0) + 1;
        if (row.field_name === 'amount') {
            const delta = asNumber(row.new_value) - asNumber(row.old_value);
            summary.amount_delta = roundMoney(summary.amount_delta + delta);
            if (delta < 0) summary.amount_decreases += 1;
        }
        if (row.field_name === 'close_date' && row.old_value && row.new_value && String(row.new_value) > String(row.old_value)) {
            summary.close_date_pushes += 1;
        }
        if (row.field_name === 'stage') {
            summary.stage_changes += 1;
        }
    }
    return summary;
}

function summarizeSlippage(historyRows, stageOrderByKey = {}) {
    const byDeal = new Map();
    for (const row of historyRows) {
        if (!byDeal.has(row.deal_id)) {
            byDeal.set(row.deal_id, {
                deal_id: row.deal_id,
                deal_name: row.deal_name,
                events: [],
                close_date_pushed: false,
                amount_decreased: false,
                stage_regressed: false,
            });
        }
        const item = byDeal.get(row.deal_id);
        const oldValue = row.old_value;
        const newValue = row.new_value;
        if (row.field_name === 'close_date' && oldValue && newValue && String(newValue) > String(oldValue)) {
            item.close_date_pushed = true;
        }
        if (row.field_name === 'amount' && asNumber(newValue) < asNumber(oldValue)) {
            item.amount_decreased = true;
        }
        if (row.field_name === 'stage') {
            const oldOrder = getStageOrder(stageOrderByKey, oldValue);
            const newOrder = getStageOrder(stageOrderByKey, newValue);
            item.stage_regressed = item.stage_regressed || (oldOrder !== null && newOrder !== null && newOrder < oldOrder);
        }
        item.events.push(row);
    }
    return Array.from(byDeal.values()).filter(item => (
        item.close_date_pushed || item.amount_decreased || item.stage_regressed
    ));
}

function compareSnapshot(currentTotals, snapshot) {
    if (!snapshot) return null;
    const previousTotals = snapshot.totals || {};
    const fields = ['pipeline', 'weighted_pipeline', 'commit', 'best_case', 'forecast_pipeline', 'omitted'];
    const deltas = {};
    for (const field of fields) {
        deltas[field] = roundMoney(asNumber(currentTotals[field]) - asNumber(previousTotals[field]));
    }
    return {
        snapshot_id: snapshot.id || null,
        snapshot_week_start: snapshot.snapshot_week_start || null,
        snapshot_created_at: snapshot.created_at || null,
        previous_totals: previousTotals,
        current_totals: currentTotals,
        deltas,
    };
}

async function getPipeline(companyId, filters = {}) {
    const deals = await dealsQueries.getPipelineDeals(companyId, filters);
    const byStage = {};
    const byForecastCategory = {};
    const byCurrency = {};
    for (const deal of deals) {
        addGroup(byStage, deal.stage, deal);
        addGroup(byForecastCategory, deal.forecast_category, deal);
        addGroup(byCurrency, deal.currency, deal);
    }

    const since = filters.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [history, stages, forecastCategories, previousSnapshot] = await Promise.all([
        dealsQueries.getDealHistorySince(companyId, since, filters),
        dealsQueries.getPipelineStages(companyId),
        dealsQueries.getForecastCategories
            ? dealsQueries.getForecastCategories(companyId)
            : Promise.resolve([]),
        dealsQueries.getLatestPipelineSnapshotBefore
            ? dealsQueries.getLatestPipelineSnapshotBefore(companyId, since, filters)
            : Promise.resolve(null),
    ]);
    const stageOrderByKey = Object.fromEntries(stages.map(stage => [stage.stage_key, stage.display_order]));
    const forecastOrderByKey = Object.fromEntries(forecastCategories.map(category => [category.category_key, category.display_order]));
    for (const [key, order] of Object.entries(forecastOrderByKey)) {
        if (byForecastCategory[key]) {
            byForecastCategory[key].order = Number(order);
        }
    }
    const totals = calculateTotals(deals);

    return {
        filters,
        totals,
        by_stage: sortGroups(Object.values(byStage)),
        by_forecast_category: sortGroups(Object.values(byForecastCategory)),
        by_currency: sortGroups(Object.values(byCurrency)),
        risky_deals: deals.filter(deal => Boolean(deal.risk_summary || deal.blocker_summary)),
        changes_since: since,
        change_summary: summarizeChanges(history),
        changes: history,
        slippage: summarizeSlippage(history, stageOrderByKey),
        snapshot_comparison: compareSnapshot(totals, previousSnapshot),
    };
}

async function getPipelineByOwner(companyId, filters = {}) {
    return getPipeline(companyId, filters);
}

async function getPipelineByTeam(companyId, filters = {}) {
    return getPipeline(companyId, filters);
}

async function getPipelineByPeriod(companyId, filters = {}) {
    return getPipeline(companyId, filters);
}

async function getPipelineStageGroups(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        totals: pipeline.totals,
        by_stage: pipeline.by_stage,
    };
}

async function getPipelineForecastGroups(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        totals: pipeline.totals,
        by_forecast_category: pipeline.by_forecast_category,
    };
}

async function getForecastTotals(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        totals: pipeline.totals,
        by_currency: pipeline.by_currency,
        snapshot_comparison: pipeline.snapshot_comparison,
    };
}

async function getPipelineChanges(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        changes_since: pipeline.changes_since,
        change_summary: pipeline.change_summary,
        changes: pipeline.changes,
        snapshot_comparison: pipeline.snapshot_comparison,
    };
}

async function getPipelineRiskyDeals(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        risky_deals: pipeline.risky_deals,
    };
}

async function getPipelineSlippage(companyId, filters = {}) {
    const pipeline = await getPipeline(companyId, filters);
    return {
        filters: pipeline.filters,
        changes_since: pipeline.changes_since,
        slippage: pipeline.slippage,
    };
}

module.exports = {
    calculateTotals,
    summarizeChanges,
    summarizeSlippage,
    compareSnapshot,
    getPipeline,
    getPipelineByOwner,
    getPipelineByTeam,
    getPipelineByPeriod,
    getPipelineStageGroups,
    getPipelineForecastGroups,
    getForecastTotals,
    getPipelineChanges,
    getPipelineRiskyDeals,
    getPipelineSlippage,
};
