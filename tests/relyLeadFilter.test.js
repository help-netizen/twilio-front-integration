'use strict';

const mockDbQuery = jest.fn();
const mockGetConnectedRelySettings = jest.fn();
const mockIsZipInTerritory = jest.fn();
const mockRadiusGetSettings = jest.fn();
const mockCountListZips = jest.fn();
const mockListRadii = jest.fn();

jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
  getConnectedRelySettings: mockGetConnectedRelySettings,
}));
jest.mock('../backend/src/services/territoryService', () => ({
  isZipInTerritory: mockIsZipInTerritory,
}));
jest.mock('../backend/src/db/territoryRadiusQueries', () => ({
  getSettings: mockRadiusGetSettings,
  countListZips: mockCountListZips,
  listRadii: mockListRadii,
}));

const { RELY_UNIT_TYPES, RELY_BRANDS } = require('../backend/src/services/relyLeadsCatalog');
const {
  isRelyLead,
  parseZipList,
  parseDescription,
  matchCatalogEntry,
  evaluateRelyLead,
  buildMarker,
  resolveRelySettings,
} = require('../backend/src/services/relyLeadFilterService');

const COMPANY = 'company-rely-filter';

const customSettings = (customZips = [], overrides = {}) => ({
  zone: { mode: 'custom', custom_zips: customZips },
  unit_types: [],
  brands: [],
  ...overrides,
});

const companySettings = (overrides = {}) => ({
  zone: { mode: 'company', custom_zips: [] },
  unit_types: [],
  brands: [],
  ...overrides,
});

function resetDependencyMocks() {
  mockDbQuery.mockReset();
  mockGetConnectedRelySettings.mockReset();
  mockIsZipInTerritory.mockReset();
  mockRadiusGetSettings.mockReset();
  mockCountListZips.mockReset();
  mockListRadii.mockReset();
  mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
  mockCountListZips.mockResolvedValue(0);
  mockListRadii.mockResolvedValue([]);
}

function clearTerritoryCalls() {
  mockIsZipInTerritory.mockClear();
  mockRadiusGetSettings.mockClear();
  mockCountListZips.mockClear();
  mockListRadii.mockClear();
}

function stubSettings(settingsOrNull) {
  if (settingsOrNull === null) {
    mockGetConnectedRelySettings.mockResolvedValue(null);
    return;
  }

  const metadata = {
    seeded_by: 'MARKETPLACE-LEADGEN-SPLIT-001',
    shared_credential: true,
  };
  if (settingsOrNull !== undefined) metadata.settings = settingsOrNull;
  mockGetConnectedRelySettings.mockResolvedValue({ metadata });
}

function expectVerdictShape(verdict) {
  expect(Object.keys(verdict).sort()).toEqual([
    'accepted',
    'active',
    'error',
    'extracted',
    'reason',
  ]);
  expect(Object.keys(verdict.extracted).sort()).toEqual(['brand', 'unit', 'zip']);
  expect(Object.keys(verdict.active).sort()).toEqual(['brands', 'unit_types', 'zone']);
}

function expectNoTerritoryCalls() {
  expect(mockIsZipInTerritory).not.toHaveBeenCalled();
  expect(mockRadiusGetSettings).not.toHaveBeenCalled();
  expect(mockCountListZips).not.toHaveBeenCalled();
  expect(mockListRadii).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetDependencyMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('relyLeadFilterService', () => {
  test('TC-F15-01: parser line-scan set (P-2)', () => {
    const rows = [
      {
        input: 'Issue: Dishwasher - not draining\nBrand: GE Profile',
        expected: { unit_raw: 'Dishwasher - not draining', brand_raw: 'GE Profile' },
      },
      {
        input: 'Issue 2: Dryer',
        expected: { unit_raw: null, brand_raw: null },
      },
      {
        input: 'Issue: Dishwasher\nIssue: Washer',
        expected: { unit_raw: 'Dishwasher', brand_raw: null },
      },
      {
        input: 'issue :  Oven',
        expected: { unit_raw: 'Oven', brand_raw: null },
      },
      {
        input: '  Brand :  GE Profile   ',
        expected: { unit_raw: null, brand_raw: 'GE Profile' },
      },
      { input: undefined, expected: { unit_raw: null, brand_raw: null } },
      { input: '', expected: { unit_raw: null, brand_raw: null } },
      { input: 'Appliance: Dryer', expected: { unit_raw: null, brand_raw: null } },
    ];

    for (const row of rows) expect(parseDescription(row.input)).toEqual(row.expected);
  });

  test('TC-F15-02: matcher token-containment set (P-1)', () => {
    expect(RELY_UNIT_TYPES).toEqual([
      'Washer',
      'Dryer',
      'Refrigerator',
      'Freezer',
      'Dishwasher',
      'Range',
      'Oven',
      'Cooktop',
      'Microwave',
      'Ice Maker',
      'Garbage Disposal',
      'Vent Hood',
    ]);
    expect(RELY_BRANDS).toEqual([
      'Whirlpool',
      'GE',
      'Samsung',
      'LG',
      'Maytag',
      'Kenmore',
      'KitchenAid',
      'Frigidaire',
      'Bosch',
      'Electrolux',
      'Amana',
      'Sub-Zero',
      'Viking',
      'Thermador',
      'Speed Queen',
    ]);
    expect(Object.isFrozen(RELY_UNIT_TYPES)).toBe(true);
    expect(Object.isFrozen(RELY_BRANDS)).toBe(true);

    const rows = [
      ['Dishwasher - not draining', RELY_UNIT_TYPES, 'Dishwasher'],
      ['Dishwasher', ['Washer'], null],
      ['GE Profile', RELY_BRANDS, 'GE'],
      ['ridge', RELY_BRANDS, null],
      ['General Electric', RELY_BRANDS, null],
      ['Sub-Zero', RELY_BRANDS, 'Sub-Zero'],
      ['sub zero', RELY_BRANDS, 'Sub-Zero'],
      ['SUB ZERO', RELY_BRANDS, 'Sub-Zero'],
      ['SubZero', RELY_BRANDS, null],
      ['SpeedQueen', RELY_BRANDS, null],
      ['Speed Queen', RELY_BRANDS, 'Speed Queen'],
      ['Microwave oven', RELY_UNIT_TYPES, 'Oven'],
      ['Refrigerator ice maker', RELY_UNIT_TYPES, 'Refrigerator'],
      ['Washer and Dryer', RELY_UNIT_TYPES, 'Washer'],
      [null, RELY_UNIT_TYPES, null],
    ];

    for (const [raw, catalog, expected] of rows) {
      expect(matchCatalogEntry(raw, catalog)).toBe(expected);
    }
  });

  test('TC-F15-03: parseZipList normalization set', () => {
    expect(parseZipList('02301, 02302; 2043\n02744, 02301')).toEqual({
      zips: ['02301', '02302', '02043', '02744'],
      invalid: [],
    });
    expect(parseZipList(['02301-1234'])).toEqual({ zips: ['02301'], invalid: [] });
    expect(parseZipList('02301, ABCDE')).toEqual({
      zips: ['02301'],
      invalid: ['ABCDE'],
    });
    expect(parseZipList(['02301', '02302', '2043'])).toEqual(
      parseZipList('02301 02302 2043')
    );
    expect(parseZipList('  \n ; , ')).toEqual({ zips: [], invalid: [] });
  });

  test('TC-F17-01: isRelyLead discriminator edges (P-12)', () => {
    const rows = [
      [{ JobSource: ' RELY ' }, true],
      [{ JobSource: 'rely' }, true],
      [{ JobSource: 'Rely' }, true],
      [{ JobSource: 'RelyX' }, false],
      [{ JobSource: 'Rely Leads' }, false],
      [{}, false],
      [{ JobSource: null }, false],
      [{ JobSource: 5 }, false],
      [{ JobSource: {} }, false],
      [undefined, false],
    ];

    for (const [payload, expected] of rows) expect(isRelyLead(payload)).toBe(expected);
  });

  test('TC-F2-01: no connected installation accepts with all filters inactive (M1)', async () => {
    stubSettings(null);

    const verdict = await evaluateRelyLead({
      JobSource: 'Rely',
      PostalCode: '02888',
      Description: 'Issue: Furnace',
    }, COMPANY);

    expect(verdict).toEqual({
      accepted: true,
      reason: null,
      extracted: { zip: '02888', unit: null, brand: null },
      active: { zone: false, unit_types: false, brands: false },
      error: null,
    });
    expectVerdictShape(verdict);
    expect(mockGetConnectedRelySettings).toHaveBeenCalledTimes(1);
    expect(mockGetConnectedRelySettings).toHaveBeenCalledWith(COMPANY);
    expectNoTerritoryCalls();
  });

  test('TC-F3-01: custom zone hit, normalization, and empty-custom inactivity (M3/M4)', async () => {
    stubSettings(customSettings(['02301', '02302', '02043', '02744']));

    const exact = await evaluateRelyLead({ PostalCode: '02744' }, COMPANY);
    const recovered = await evaluateRelyLead({ PostalCode: '2744' }, COMPANY);

    expect(exact).toMatchObject({
      accepted: true,
      extracted: { zip: '02744' },
      active: { zone: true },
      error: null,
    });
    expect(recovered).toMatchObject({
      accepted: true,
      extracted: { zip: '02744' },
      active: { zone: true },
      error: null,
    });

    stubSettings(customSettings([]));
    const emptyWithZip = await evaluateRelyLead({ PostalCode: '99999' }, COMPANY);
    const emptyWithoutZip = await evaluateRelyLead({}, COMPANY);

    expect(emptyWithZip).toMatchObject({ accepted: true, active: { zone: false } });
    expect(emptyWithoutZip).toMatchObject({
      accepted: true,
      extracted: { zip: null },
      active: { zone: false },
    });
    expectNoTerritoryCalls();
  });

  test('TC-F4-01: custom zone miss returns only out_of_area (M5/M17)', async () => {
    stubSettings(customSettings(['02301', '02302', '02043', '02744'], {
      unit_types: ['Dishwasher'],
    }));

    const verdict = await evaluateRelyLead({
      PostalCode: '02888',
      Description: 'Issue: Washer',
    }, COMPANY);

    expect(verdict).toEqual({
      accepted: false,
      reason: 'out_of_area',
      extracted: { zip: '02888', unit: null, brand: null },
      active: { zone: true, unit_types: true, brands: false },
      error: null,
    });
    expectVerdictShape(verdict);
    expectNoTerritoryCalls();

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-13T12:34:56.000Z'));
    expect(buildMarker(verdict)).toEqual({
      rejected: true,
      reason: 'out_of_area',
      evaluated_at: '2026-07-13T12:34:56.000Z',
      zip: '02888',
      unit: null,
      brand: null,
    });
  });

  test('TC-F5-01: active custom zone rejects a missing ZIP without territory calls (M5a)', async () => {
    stubSettings(customSettings(['02301']));

    const absent = await evaluateRelyLead({}, COMPANY);
    const empty = await evaluateRelyLead({ PostalCode: '' }, COMPANY);

    for (const verdict of [absent, empty]) {
      expect(verdict).toMatchObject({
        accepted: false,
        reason: 'out_of_area',
        extracted: { zip: null },
        active: { zone: true },
        error: null,
      });
    }
    expectNoTerritoryCalls();
  });

  test('TC-F6-01: company list hit passes without the activity guard (M6/P-4)', async () => {
    stubSettings(companySettings());
    mockIsZipInTerritory.mockResolvedValue({
      inside: true,
      area: 'Brockton',
      city: 'Brockton',
      state: 'MA',
      zip: '02301',
      mode: 'list',
    });

    const verdict = await evaluateRelyLead({ PostalCode: '02301' }, COMPANY);

    expect(verdict).toMatchObject({
      accepted: true,
      reason: null,
      active: { zone: true },
      error: null,
    });
    expect(mockIsZipInTerritory).toHaveBeenCalledTimes(1);
    expect(mockIsZipInTerritory).toHaveBeenCalledWith(COMPANY, '02301');
    expect(mockRadiusGetSettings).not.toHaveBeenCalled();
    expect(mockCountListZips).not.toHaveBeenCalled();
    expect(mockListRadii).not.toHaveBeenCalled();
  });

  test('TC-F7-01: company list miss with data rejects out_of_area (M7)', async () => {
    stubSettings(companySettings());
    mockIsZipInTerritory.mockResolvedValue({ inside: false, mode: 'list' });
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
    mockCountListZips.mockResolvedValue(41);

    const verdict = await evaluateRelyLead({ PostalCode: '02888' }, COMPANY);

    expect(verdict).toMatchObject({
      accepted: false,
      reason: 'out_of_area',
      active: { zone: true },
      error: null,
    });
    expect(mockRadiusGetSettings).toHaveBeenCalledTimes(1);
    expect(mockRadiusGetSettings).toHaveBeenCalledWith(COMPANY);
    expect(mockCountListZips).toHaveBeenCalledTimes(1);
    expect(mockCountListZips).toHaveBeenCalledWith(COMPANY);
    expect(mockListRadii).not.toHaveBeenCalled();
  });

  test('TC-F8-01: zero territory data deactivates company zone (M2/M8)', async () => {
    expect(resolveRelySettings({
      settings: {
        zone: { mode: 'teleport' },
        unit_types: ['Dishwasher', 'Toaster'],
        brands: 'x',
      },
    })).toEqual({
      zone: { mode: 'company', custom_zips: [] },
      unit_types: ['Dishwasher'],
      brands: [],
    });
    expect(resolveRelySettings({ seeded_by: 'seed' })).toEqual(companySettings());

    stubSettings(undefined);
    mockIsZipInTerritory.mockResolvedValue({ inside: false, mode: 'list' });
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
    mockCountListZips.mockResolvedValue(0);
    const listVerdict = await evaluateRelyLead({ PostalCode: '02888' }, COMPANY);
    expect(listVerdict).toMatchObject({
      accepted: true,
      reason: null,
      active: { zone: false },
      error: null,
    });

    clearTerritoryCalls();
    mockIsZipInTerritory.mockResolvedValue({ inside: false, mode: 'radius' });
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'radius' });
    mockListRadii.mockResolvedValue([]);
    const radiusVerdict = await evaluateRelyLead({ PostalCode: '02043' }, COMPANY);
    expect(radiusVerdict).toMatchObject({
      accepted: true,
      reason: null,
      active: { zone: false },
      error: null,
    });
    expect(mockCountListZips).not.toHaveBeenCalled();
    expect(mockListRadii).toHaveBeenCalledTimes(1);

    clearTerritoryCalls();
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
    mockCountListZips.mockResolvedValue(0);
    const missingZipVerdict = await evaluateRelyLead({}, COMPANY);
    expect(missingZipVerdict).toMatchObject({
      accepted: true,
      extracted: { zip: null },
      active: { zone: false },
      error: null,
    });
    expect(mockIsZipInTerritory).not.toHaveBeenCalled();
  });

  test('TC-F9-01: company radius hit passes through the territory seam (M9)', async () => {
    stubSettings(companySettings());
    mockIsZipInTerritory.mockResolvedValue({
      inside: true,
      area: '02043',
      city: 'Hingham',
      state: 'MA',
      zip: '02043',
      mode: 'radius',
    });

    const verdict = await evaluateRelyLead({ PostalCode: '02043' }, COMPANY);

    expect(verdict).toMatchObject({
      accepted: true,
      reason: null,
      active: { zone: true },
      error: null,
    });
    expect(mockIsZipInTerritory).toHaveBeenCalledTimes(1);
    expect(mockIsZipInTerritory).toHaveBeenCalledWith(COMPANY, '02043');
    expect(mockRadiusGetSettings).not.toHaveBeenCalled();
    expect(mockCountListZips).not.toHaveBeenCalled();
    expect(mockListRadii).not.toHaveBeenCalled();
  });

  test('TC-F10-01: radius miss and geocode-null both reject as decisions (M10/M10a)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    stubSettings(companySettings());
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'radius' });
    mockListRadii.mockResolvedValue([{ id: 1, radius_miles: 25 }]);

    for (const zip of ['03038', '02043']) {
      clearTerritoryCalls();
      mockIsZipInTerritory.mockResolvedValue({ inside: false, mode: 'radius', zip });

      const verdict = await evaluateRelyLead({ PostalCode: zip }, COMPANY);

      expect(verdict).toMatchObject({
        accepted: false,
        reason: 'out_of_area',
        extracted: { zip },
        active: { zone: true },
        error: null,
      });
      expect(mockIsZipInTerritory).toHaveBeenCalledWith(COMPANY, zip);
      expect(mockRadiusGetSettings).toHaveBeenCalledTimes(1);
      expect(mockListRadii).toHaveBeenCalledTimes(1);
      expect(mockCountListZips).not.toHaveBeenCalled();
    }
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('TC-F11-01: company mode with missing ZIP is decided by activity guard (M11)', async () => {
    stubSettings(companySettings());
    mockRadiusGetSettings.mockResolvedValue({ active_mode: 'list' });
    mockCountListZips.mockResolvedValue(41);

    const activeVerdict = await evaluateRelyLead({}, COMPANY);
    expect(activeVerdict).toMatchObject({
      accepted: false,
      reason: 'out_of_area',
      extracted: { zip: null },
      active: { zone: true },
      error: null,
    });
    expect(mockIsZipInTerritory).not.toHaveBeenCalled();

    clearTerritoryCalls();
    mockCountListZips.mockResolvedValue(0);
    const inactiveVerdict = await evaluateRelyLead({}, COMPANY);
    expect(inactiveVerdict).toMatchObject({
      accepted: true,
      reason: null,
      extracted: { zip: null },
      active: { zone: false },
      error: null,
    });
    expect(mockIsZipInTerritory).not.toHaveBeenCalled();
  });

  test('TC-F12-01: unit filter accepts, rejects, and fails open on missing values (M12-M14)', async () => {
    stubSettings(customSettings([], { unit_types: ['Dishwasher'] }));

    const rows = [
      ['Issue: Dishwasher - not draining', true, null, 'Dishwasher'],
      ['Issue: Washer', false, 'unit_not_serviced', 'Washer'],
      ['Customer needs help', true, null, null],
      ['Issue: Furnace', true, null, null],
    ];

    for (const [description, accepted, reason, unit] of rows) {
      const verdict = await evaluateRelyLead({ Description: description }, COMPANY);
      expect(verdict).toMatchObject({
        accepted,
        reason,
        extracted: { unit },
        active: { zone: false, unit_types: true, brands: false },
        error: null,
      });
    }

    stubSettings(customSettings([], { unit_types: [] }));
    const inactive = await evaluateRelyLead({ Description: 'Issue: Washer' }, COMPANY);
    expect(inactive).toMatchObject({
      accepted: true,
      extracted: { unit: null },
      active: { unit_types: false },
    });
    expectNoTerritoryCalls();
  });

  test('TC-F13-01: brand filter is evaluated last (M15/M16)', async () => {
    stubSettings(customSettings([], { brands: ['Whirlpool', 'GE'] }));

    const rows = [
      ['Brand: Kenmore', false, 'brand_not_serviced', 'Kenmore'],
      ['Customer omitted the brand', true, null, null],
      ['Brand: General Electric', true, null, null],
      ['Brand: SubZero', true, null, null],
      ['Brand: GE Profile', true, null, 'GE'],
    ];

    for (const [description, accepted, reason, brand] of rows) {
      const verdict = await evaluateRelyLead({ Description: description }, COMPANY);
      expect(verdict).toMatchObject({
        accepted,
        reason,
        extracted: { brand },
        active: { zone: false, unit_types: false, brands: true },
        error: null,
      });
    }
    expectNoTerritoryCalls();
  });

  test('TC-F14-01: AND ordering returns exactly the first failure reason (M17)', async () => {
    stubSettings(customSettings(['02301'], {
      unit_types: ['Dishwasher'],
      brands: ['Whirlpool'],
    }));

    const zoneFailure = await evaluateRelyLead({
      PostalCode: '02888',
      Description: 'Issue: Washer\nBrand: Kenmore',
    }, COMPANY);
    expect(zoneFailure).toMatchObject({
      accepted: false,
      reason: 'out_of_area',
      extracted: { zip: '02888', unit: null, brand: null },
      active: { zone: true, unit_types: true, brands: true },
    });

    const unitFailure = await evaluateRelyLead({
      PostalCode: '02301',
      Description: 'Issue: Washer\nBrand: Kenmore',
    }, COMPANY);
    expect(unitFailure).toMatchObject({
      accepted: false,
      reason: 'unit_not_serviced',
      extracted: { unit: 'Washer', brand: null },
      active: { zone: true, unit_types: true, brands: true },
    });

    const brandFailure = await evaluateRelyLead({
      PostalCode: '02301',
      Description: 'Issue: Dishwasher\nBrand: Kenmore',
    }, COMPANY);
    expect(brandFailure).toMatchObject({
      accepted: false,
      reason: 'brand_not_serviced',
      extracted: { unit: 'Dishwasher', brand: 'Kenmore' },
      active: { zone: true, unit_types: true, brands: true },
    });

    clearTerritoryCalls();
    stubSettings(companySettings({
      unit_types: ['Dishwasher'],
      brands: ['Whirlpool'],
    }));
    mockIsZipInTerritory.mockResolvedValue({ inside: true, mode: 'list', zip: '02301' });
    const companyUnitFailure = await evaluateRelyLead({
      PostalCode: '02301',
      Description: 'Issue: Washer\nBrand: Kenmore',
    }, COMPANY);
    expect(companyUnitFailure).toMatchObject({
      accepted: false,
      reason: 'unit_not_serviced',
      active: { zone: true, unit_types: true, brands: true },
    });
    expect(mockIsZipInTerritory).toHaveBeenCalledWith(COMPANY, '02301');
    expect(mockRadiusGetSettings).not.toHaveBeenCalled();
    expect(mockCountListZips).not.toHaveBeenCalled();
    expect(mockListRadii).not.toHaveBeenCalled();
  });

  test('TC-F16-01: any thrown exception fails open with the exact error log (M18)', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    async function expectFailOpen(payload, err) {
      consoleSpy.mockClear();
      const verdict = await evaluateRelyLead(payload, COMPANY);
      expect(verdict).toMatchObject({ accepted: true, reason: null, error: err.message });
      expectVerdictShape(verdict);
      expect(err.stack).toBeTruthy();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith('[RelyLeadFilter] fail-open', err);
    }

    const settingsError = new Error('relation "marketplace_installations" does not exist');
    mockGetConnectedRelySettings.mockRejectedValue(settingsError);
    await expectFailOpen({ PostalCode: '02301' }, settingsError);

    resetDependencyMocks();
    const territoryError = new Error('territory settings read failed');
    stubSettings(companySettings());
    mockIsZipInTerritory.mockRejectedValue(territoryError);
    await expectFailOpen({ PostalCode: '02301' }, territoryError);

    resetDependencyMocks();
    const parserError = new Error('description getter failed');
    stubSettings(customSettings([], { unit_types: ['Dishwasher'] }));
    const poisonedPayload = {};
    Object.defineProperty(poisonedPayload, 'Description', {
      get() {
        throw parserError;
      },
    });
    await expectFailOpen(poisonedPayload, parserError);
  });
});
