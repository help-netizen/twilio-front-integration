import { describe, expect, it } from 'vitest';
import wizardRaw from './CreateLeadJobWizard.tsx?raw';

/**
 * The wizard a dispatcher opens from a timeline when an unknown number calls:
 * it creates the lead, then converts it into a job.
 *
 * It used to create the lead as `Converted` when a job was to follow — claiming
 * the end state one step early. mig245 then added
 * CHECK ((status = 'Converted') = converted_to_job), and since nothing had set
 * the boolean, every such lead was refused by the database. The INSERT rolled
 * back and the lead simply did not exist; the dispatcher, seeing the failure,
 * created the job by hand, so the customer was served and only the lead record
 * and its channel attribution were lost. Nothing in the suite noticed.
 */
describe('unknown-caller wizard', () => {
    it('creates the lead as Submitted and lets the conversion convert it', () => {
        expect(wizardRaw).toContain("Status: 'Submitted', JobSource: 'Phone Call'");
        // Not "Converted when a job follows" — that is what convertLead is for.
        expect(wizardRaw).not.toContain("withJob ? 'Converted'");
    });

    it('never asserts Converted anywhere in the payload it sends', () => {
        // Any spelling of it is the same bug: Converted is a state the backend
        // MAKES true by linking a job, never one a client may claim.
        const statusAssignments = [...wizardRaw.matchAll(/Status:\s*([^,\n]+)/g)].map(match => match[1].trim());
        expect(statusAssignments.length).toBeGreaterThan(0);
        statusAssignments.forEach(value => expect(value).not.toContain('Converted'));
    });

    it('still converts through the endpoint that links the job', () => {
        // The lead must end up Converted — that is what the funnel and the
        // channel ROAS report count. It gets there via convertLead, which
        // creates the job and flips status and converted_to_job together.
        expect(wizardRaw).toContain('leadsApi.convertLead(createdUUID');
        expect(wizardRaw).toContain('if (withJob && createdUUID)');
    });
});
