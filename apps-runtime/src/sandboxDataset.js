'use strict';

/**
 * Curated sandbox dataset for App Studio (APP-SANDBOX-001).
 *
 * The shape — status mix, lead sources, city spread, hours of the day and ticket
 * sizes — mirrors two weeks of real field-service traffic so that apps built here
 * behave the same way against a live company. Every person, address, phone number,
 * email address and note is synthetic: phone numbers sit in the 555-01xx range
 * reserved for fiction and addresses use example.com, so nothing here can reach
 * a real customer.
 *
 * Dates are day offsets from the sandbox anchor, never absolute — fixtures pinned
 * to a literal date silently go stale and every "today" app then reports zero.
 * Every `hour` is a company-local wall-clock hour; fixture generation converts
 * it to the corresponding UTC instant using this dataset's `timezone`.
 *
 * Generated once; edit this file directly if the showcase needs to change.
 */

const CUSTOMERS = [
    {
        "first_name": "Marta",
        "last_name": "Feldman",
        "full_name": "Marta Feldman",
        "phone": "+16175550100",
        "email": "marta.feldman@example.com",
        "address": "212 Alder Row",
        "city": "Boston",
        "postal_code": "02127"
    },
    {
        "first_name": "Devin",
        "last_name": "Kowalczyk",
        "full_name": "Devin Kowalczyk",
        "phone": "+16175550101",
        "email": "devin.kowalczyk@example.com",
        "address": "48 Pearlbrook St",
        "city": "Brockton",
        "postal_code": "02301"
    },
    {
        "first_name": "Aisha",
        "last_name": "Bello",
        "full_name": "Aisha Bello",
        "phone": "+16175550102",
        "email": "aisha.bello@example.com",
        "address": "1907 Kestrel Ave",
        "city": "Quincy",
        "postal_code": "02169"
    },
    {
        "first_name": "Grant",
        "last_name": "Ferrara",
        "full_name": "Grant Ferrara",
        "phone": "+16175550103",
        "email": "grant.ferrara@example.com",
        "address": "76 Muirfield Ln",
        "city": "Ashland",
        "postal_code": "01721"
    },
    {
        "first_name": "Yuki",
        "last_name": "Tanabe",
        "full_name": "Yuki Tanabe",
        "phone": "+16175550104",
        "email": "yuki.tanabe@example.com",
        "address": "533 Halsted Way",
        "city": "Framingham",
        "postal_code": "01701"
    },
    {
        "first_name": "Rowan",
        "last_name": "McAllister",
        "full_name": "Rowan McAllister",
        "phone": "+16175550105",
        "email": "rowan.mcallister@example.com",
        "address": "84 Tidewater Dr",
        "city": "Winthrop",
        "postal_code": "02152"
    },
    {
        "first_name": "Sofia",
        "last_name": "Marchetti",
        "full_name": "Sofia Marchetti",
        "phone": "+16175550106",
        "email": "sofia.marchetti@example.com",
        "address": "311 Copley Bend",
        "city": "Cambridge",
        "postal_code": "02139"
    },
    {
        "first_name": "Terrell",
        "last_name": "Boone",
        "full_name": "Terrell Boone",
        "phone": "+16175550107",
        "email": "terrell.boone@example.com",
        "address": "95 Lindenwood Ct",
        "city": "Randolph",
        "postal_code": "02368"
    },
    {
        "first_name": "Nadia",
        "last_name": "Haddad",
        "full_name": "Nadia Haddad",
        "phone": "+16175550108",
        "email": "nadia.haddad@example.com",
        "address": "1420 Ferncliff Rd",
        "city": "Sharon",
        "postal_code": "02067"
    },
    {
        "first_name": "Peter",
        "last_name": "Vandenberg",
        "full_name": "Peter Vandenberg",
        "phone": "+16175550109",
        "email": "peter.vandenberg@example.com",
        "address": "27 Quarry Hill",
        "city": "Norwood",
        "postal_code": "02062"
    },
    {
        "first_name": "Camille",
        "last_name": "Okonjo",
        "full_name": "Camille Okonjo",
        "phone": "+16175550110",
        "email": "camille.okonjo@example.com",
        "address": "660 Sagamore St",
        "city": "Somerville",
        "postal_code": "02143"
    },
    {
        "first_name": "Isaac",
        "last_name": "Berkowitz",
        "full_name": "Isaac Berkowitz",
        "phone": "+16175550111",
        "email": "isaac.berkowitz@example.com",
        "address": "18 Wrenfield Ave",
        "city": "Westwood",
        "postal_code": "02090"
    },
    {
        "first_name": "Lucia",
        "last_name": "Amaya",
        "full_name": "Lucia Amaya",
        "phone": "+16175550112",
        "email": "lucia.amaya@example.com",
        "address": "740 Bramble Path",
        "city": "Boston",
        "postal_code": "02130"
    },
    {
        "first_name": "Owen",
        "last_name": "Kilbride",
        "full_name": "Owen Kilbride",
        "phone": "+16175550113",
        "email": "owen.kilbride@example.com",
        "address": "52 Stonegate Row",
        "city": "Brockton",
        "postal_code": "02302"
    },
    {
        "first_name": "Priscilla",
        "last_name": "Nakamura",
        "full_name": "Priscilla Nakamura",
        "phone": "+16175550114",
        "email": "priscilla.nakamura@example.com",
        "address": "1288 Harborview",
        "city": "Quincy",
        "postal_code": "02171"
    },
    {
        "first_name": "Emmett",
        "last_name": "Larose",
        "full_name": "Emmett Larose",
        "phone": "+16175550115",
        "email": "emmett.larose@example.com",
        "address": "39 Fieldstone Way",
        "city": "Ashland",
        "postal_code": "01721"
    },
    {
        "first_name": "Dalia",
        "last_name": "Rosenthal",
        "full_name": "Dalia Rosenthal",
        "phone": "+16175550116",
        "email": "dalia.rosenthal@example.com",
        "address": "905 Kingsley Ave",
        "city": "Framingham",
        "postal_code": "01702"
    },
    {
        "first_name": "Andre",
        "last_name": "Petrosyan",
        "full_name": "Andre Petrosyan",
        "phone": "+16175550117",
        "email": "andre.petrosyan@example.com",
        "address": "64 Seagrass Ln",
        "city": "Winthrop",
        "postal_code": "02152"
    },
    {
        "first_name": "Harriet",
        "last_name": "Ogunyemi",
        "full_name": "Harriet Ogunyemi",
        "phone": "+16175550118",
        "email": "harriet.ogunyemi@example.com",
        "address": "187 Radcliffe St",
        "city": "Cambridge",
        "postal_code": "02141"
    },
    {
        "first_name": "Julian",
        "last_name": "Sandoval",
        "full_name": "Julian Sandoval",
        "phone": "+16175550119",
        "email": "julian.sandoval@example.com",
        "address": "412 Millbrook Rd",
        "city": "Randolph",
        "postal_code": "02368"
    },
    {
        "first_name": "Freya",
        "last_name": "Lindqvist",
        "full_name": "Freya Lindqvist",
        "phone": "+16175550120",
        "email": "freya.lindqvist@example.com",
        "address": "73 Ashgrove Ct",
        "city": "Sharon",
        "postal_code": "02067"
    },
    {
        "first_name": "Marcus",
        "last_name": "Whitfield",
        "full_name": "Marcus Whitfield",
        "phone": "+16175550121",
        "email": "marcus.whitfield@example.com",
        "address": "1550 Birchmont",
        "city": "Norwood",
        "postal_code": "02062"
    },
    {
        "first_name": "Ingrid",
        "last_name": "Castellanos",
        "full_name": "Ingrid Castellanos",
        "phone": "+16175550122",
        "email": "ingrid.castellanos@example.com",
        "address": "96 Tremaine St",
        "city": "Somerville",
        "postal_code": "02144"
    },
    {
        "first_name": "Bennett",
        "last_name": "Ashworth",
        "full_name": "Bennett Ashworth",
        "phone": "+16175550123",
        "email": "bennett.ashworth@example.com",
        "address": "830 Foxglove Ln",
        "city": "Westwood",
        "postal_code": "02090"
    },
    {
        "first_name": "Simone",
        "last_name": "Devereaux",
        "full_name": "Simone Devereaux",
        "phone": "+16175550124",
        "email": "simone.devereaux@example.com",
        "address": "145 Cobblestone",
        "city": "Boston",
        "postal_code": "02118"
    },
    {
        "first_name": "Theo",
        "last_name": "Mbeki",
        "full_name": "Theo Mbeki",
        "phone": "+16175550125",
        "email": "theo.mbeki@example.com",
        "address": "58 Harrowgate Rd",
        "city": "Brockton",
        "postal_code": "02301"
    },
    {
        "first_name": "Rosalind",
        "last_name": "Achterberg",
        "full_name": "Rosalind Achterberg",
        "phone": "+16175550126",
        "email": "rosalind.achterberg@example.com",
        "address": "1120 Windermere",
        "city": "Quincy",
        "postal_code": "02169"
    },
    {
        "first_name": "Kofi",
        "last_name": "Danquah",
        "full_name": "Kofi Danquah",
        "phone": "+16175550127",
        "email": "kofi.danquah@example.com",
        "address": "29 Larkspur Way",
        "city": "Framingham",
        "postal_code": "01701"
    }
];

const TECHNICIANS = [
    "Miles Trevino",
    "Priya Raman",
    "Desmond Ilori",
    "Corinne Vaziri"
];

const SERVICES = [
    {
        "name": "Refrigerator Repair",
        "type": "Appliance Repair",
        "price": 320
    },
    {
        "name": "Washer Repair",
        "type": "Appliance Repair",
        "price": 265
    },
    {
        "name": "Dryer Repair",
        "type": "Appliance Repair",
        "price": 210
    },
    {
        "name": "Dishwasher Repair",
        "type": "Appliance Repair",
        "price": 285
    },
    {
        "name": "Oven & Range Repair",
        "type": "Appliance Repair",
        "price": 395
    },
    {
        "name": "Freezer Repair",
        "type": "Appliance Repair",
        "price": 340
    },
    {
        "name": "Microwave Repair",
        "type": "Appliance Repair",
        "price": 180
    },
    {
        "name": "Diagnostic Visit",
        "type": "Diagnostic",
        "price": 95
    }
];

const JOBS = [
    {
        "day_offset": -13,
        "hour": 9,
        "status": "Job is Done",
        "customer_index": 0,
        "service_index": 0,
        "technician_index": 0,
        "billing": "paid",
        "note": "Kenmore Elite refrigerator checkup needed, not working properly"
    },
    {
        "day_offset": -13,
        "hour": 13,
        "status": "Job is Done",
        "customer_index": 1,
        "service_index": 1,
        "technician_index": 1,
        "billing": "paid",
        "note": "Replace moldy rubber seal in LG front load washer, clean sludge from drain; gasket and tool on hand"
    },
    {
        "day_offset": -12,
        "hour": 8,
        "status": "Job is Done",
        "customer_index": 2,
        "service_index": 4,
        "technician_index": 2,
        "billing": "paid",
        "note": "Install an over-oven microwave, replacing an existing unit with the same model"
    },
    {
        "day_offset": -12,
        "hour": 15,
        "status": "Canceled",
        "customer_index": 3,
        "service_index": 2,
        "technician_index": 3,
        "billing": null,
        "note": "Customer purchased a dryer, belt needs to be replaced"
    },
    {
        "day_offset": -11,
        "hour": 10,
        "status": "Job is Done",
        "customer_index": 4,
        "service_index": 3,
        "technician_index": 0,
        "billing": "paid",
        "note": "Bosch dishwasher runs no water"
    },
    {
        "day_offset": -10,
        "hour": 9,
        "status": "Visit completed",
        "customer_index": 5,
        "service_index": 7,
        "technician_index": 1,
        "billing": "partial",
        "note": "Samsung refrigerator not cooling like it should"
    },
    {
        "day_offset": -10,
        "hour": 14,
        "status": "Job is Done",
        "customer_index": 6,
        "service_index": 5,
        "technician_index": 2,
        "billing": "paid",
        "note": "Summit freezer icing over, losing temperature"
    },
    {
        "day_offset": -9,
        "hour": 11,
        "status": "Visit completed",
        "customer_index": 7,
        "service_index": 0,
        "technician_index": 3,
        "billing": "partial",
        "note": "GE refrigerator stopped working"
    },
    {
        "day_offset": -8,
        "hour": 8,
        "status": "Job is Done",
        "customer_index": 8,
        "service_index": 6,
        "technician_index": 0,
        "billing": "paid",
        "note": "Microwave turning on but food not heating properly"
    },
    {
        "day_offset": -8,
        "hour": 16,
        "status": "Canceled",
        "customer_index": 9,
        "service_index": 1,
        "technician_index": 1,
        "billing": null,
        "note": "GE washer banging and crashing, drum or spinner issue"
    },
    {
        "day_offset": -7,
        "hour": 10,
        "status": "Job is Done",
        "customer_index": 10,
        "service_index": 2,
        "technician_index": 2,
        "billing": "paid",
        "note": "Whirlpool electric clothes dryer, service call without parts"
    },
    {
        "day_offset": -6,
        "hour": 9,
        "status": "Visit completed",
        "customer_index": 11,
        "service_index": 4,
        "technician_index": 3,
        "billing": "partial",
        "note": "Oven safety check, small fire in oven, ensure functioning as intended"
    },
    {
        "day_offset": -6,
        "hour": 13,
        "status": "Job is Done",
        "customer_index": 12,
        "service_index": 3,
        "technician_index": 0,
        "billing": "paid",
        "note": "Wolf oven interior floor repair, LG washer/dryer diagnostics and cleaning, Bosch dishwasher diagnostics and cleaning"
    },
    {
        "day_offset": -5,
        "hour": 15,
        "status": "Waiting for parts",
        "customer_index": 13,
        "service_index": 0,
        "technician_index": 1,
        "billing": "partial",
        "note": "Amana Maytag fridge is not working, model abc2037dts"
    },
    {
        "day_offset": -4,
        "hour": 8,
        "status": "Job is Done",
        "customer_index": 14,
        "service_index": 7,
        "technician_index": 2,
        "billing": "paid",
        "note": "Beverage center under cabinet stopped working"
    },
    {
        "day_offset": -3,
        "hour": 11,
        "status": "Visit completed",
        "customer_index": 15,
        "service_index": 5,
        "technician_index": 3,
        "billing": "partial",
        "note": "Estimate approved by customer for Sub-Zero freezer repair"
    },
    {
        "day_offset": -2,
        "hour": 14,
        "status": "Follow Up with Client",
        "customer_index": 16,
        "service_index": 1,
        "technician_index": 0,
        "billing": null,
        "note": "Washer hard to change speed and water doesn't drain"
    },
    {
        "day_offset": -1,
        "hour": 9,
        "status": "Visit completed",
        "customer_index": 17,
        "service_index": 6,
        "technician_index": 1,
        "billing": "partial",
        "note": "Bosch microwave repair part on backorder, customer notified of delay"
    },
    {
        "day_offset": 0,
        "hour": 8,
        "status": "Job is Done",
        "customer_index": 18,
        "service_index": 2,
        "technician_index": 2,
        "billing": "paid",
        "note": "Whirlpool coin-operated dryer functioning without requiring coins"
    },
    {
        "day_offset": 0,
        "hour": 10,
        "status": "On the way",
        "customer_index": 19,
        "service_index": 4,
        "technician_index": 3,
        "billing": null,
        "note": "Wolf 6-burner range, ceramic igniter and electrode broken on front left burner"
    },
    {
        "day_offset": 0,
        "hour": 11,
        "status": "Visit completed",
        "customer_index": 20,
        "service_index": 0,
        "technician_index": 0,
        "billing": "partial",
        "note": "Samsung refrigerator stops working intermittently, temperature not working properly"
    },
    {
        "day_offset": 0,
        "hour": 13,
        "status": "On the way",
        "customer_index": 21,
        "service_index": 3,
        "technician_index": 1,
        "billing": null,
        "note": "GE Profile dishwasher leaking, dripping to basement, water damage"
    },
    {
        "day_offset": 0,
        "hour": 15,
        "status": "Waiting for parts",
        "customer_index": 22,
        "service_index": 5,
        "technician_index": 2,
        "billing": null,
        "note": "Whirlpool top loading washer model # WTW8127LC"
    },
    {
        "day_offset": 0,
        "hour": 17,
        "status": "Submitted",
        "customer_index": 23,
        "service_index": 7,
        "technician_index": 3,
        "billing": null,
        "note": "Fridge purchased March 19th, now making weird sounds"
    },
    {
        "day_offset": 1,
        "hour": 9,
        "status": "Submitted",
        "customer_index": 24,
        "service_index": 1,
        "technician_index": 0,
        "billing": null,
        "note": "LG washing machine not filling, error code appears"
    },
    {
        "day_offset": 1,
        "hour": 14,
        "status": "Submitted",
        "customer_index": 25,
        "service_index": 6,
        "technician_index": 1,
        "billing": null,
        "note": "Whirlpool clothes washing machine broken"
    },
    {
        "day_offset": 2,
        "hour": 10,
        "status": "Submitted",
        "customer_index": 26,
        "service_index": 4,
        "technician_index": 2,
        "billing": null,
        "note": "Thermador gas stove, three burners not working, igniter needs to be replaced"
    },
    {
        "day_offset": 3,
        "hour": 12,
        "status": "Submitted",
        "customer_index": 27,
        "service_index": 2,
        "technician_index": 3,
        "billing": null,
        "note": "Dryer blowing hot air, might be damper issue"
    }
];

const LEADS = [
    {
        "day_offset": -16,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 0,
        "job_index": 0,
        "note": "KitchenAid refrigerator leaking water, customer wants earliest possible visit"
    },
    {
        "day_offset": -17,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 1,
        "job_index": 1,
        "note": "Samsung dishwasher not starting cycle, customer wants estimate before scheduling"
    },
    {
        "day_offset": -17,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 2,
        "job_index": 2,
        "note": "GE oven not heating to temperature, available weekends only"
    },
    {
        "day_offset": -18,
        "status": "Converted",
        "source": "Pro Referral",
        "customer_index": 3,
        "job_index": 3,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -18,
        "status": "Converted",
        "source": "Web site order",
        "customer_index": 4,
        "job_index": 4,
        "note": "Frigidaire dishwasher not draining, available Tuesdays and Thursdays"
    },
    {
        "day_offset": -13,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 5,
        "job_index": 5,
        "note": "Sub-Zero freezer not freezing, urgent repair needed this week"
    },
    {
        "day_offset": -14,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 6,
        "job_index": 6,
        "note": "LG washing machine making grinding sounds, customer needs evening appointment"
    },
    {
        "day_offset": -14,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 7,
        "job_index": 7,
        "note": "Amana refrigerator temperature fluctuating, customer needs service before vacation"
    },
    {
        "day_offset": -14,
        "status": "Converted",
        "source": "Pro Referral",
        "customer_index": 8,
        "job_index": 8,
        "note": "Bosch microwave not heating, customer asking about service call fee"
    },
    {
        "day_offset": -15,
        "status": "Converted",
        "source": "Web site order",
        "customer_index": 9,
        "job_index": 9,
        "note": "Electrolux washer overflowing, urgent, available today"
    },
    {
        "day_offset": -10,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 10,
        "job_index": 10,
        "note": "Maytag dryer not producing heat, available any morning next week"
    },
    {
        "day_offset": -10,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 11,
        "job_index": 11,
        "note": "Viking range igniter clicking constantly, customer wants to compare prices"
    },
    {
        "day_offset": -11,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 12,
        "job_index": 12,
        "note": "Kenmore oven door not closing properly, customer looking for rough cost"
    },
    {
        "day_offset": -11,
        "status": "Converted",
        "source": "Pro Referral",
        "customer_index": 13,
        "job_index": 13,
        "note": "JennAir cooktop burner not lighting, available after 4pm"
    },
    {
        "day_offset": -11,
        "status": "Converted",
        "source": "Web site order",
        "customer_index": 14,
        "job_index": 14,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 15,
        "job_index": 15,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 16,
        "job_index": 16,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 17,
        "job_index": 17,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "Pro Referral",
        "customer_index": 18,
        "job_index": 18,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -7,
        "status": "Converted",
        "source": "Web site order",
        "customer_index": 19,
        "job_index": 19,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -3,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 20,
        "job_index": 20,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -4,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 21,
        "job_index": 21,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -5,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 22,
        "job_index": 22,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "Pro Referral",
        "customer_index": 23,
        "job_index": 23,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -6,
        "status": "Converted",
        "source": "Web site order",
        "customer_index": 24,
        "job_index": 24,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -2,
        "status": "Converted",
        "source": "Phone Call",
        "customer_index": 25,
        "job_index": 25,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -2,
        "status": "Converted",
        "source": "Yelp",
        "customer_index": 26,
        "job_index": 26,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -2,
        "status": "Converted",
        "source": "AI Phone",
        "customer_index": 27,
        "job_index": 27,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -12,
        "status": "Lost",
        "source": "Yelp",
        "customer_index": 5,
        "job_index": null,
        "note": "Maytag dryer not producing heat, available any morning next week"
    },
    {
        "day_offset": -11,
        "status": "Lost",
        "source": "Phone Call",
        "customer_index": 12,
        "job_index": null,
        "note": "Viking range igniter clicking constantly, customer wants to compare prices"
    },
    {
        "day_offset": -9,
        "status": "Lost",
        "source": "AI Phone",
        "customer_index": 3,
        "job_index": null,
        "note": "Frigidaire dishwasher not draining, available Tuesdays and Thursdays"
    },
    {
        "day_offset": -8,
        "status": "Lost",
        "source": "Web site order",
        "customer_index": 8,
        "job_index": null,
        "note": "Amana refrigerator temperature fluctuating, customer needs service before vacation"
    },
    {
        "day_offset": -6,
        "status": "Lost",
        "source": "Yelp",
        "customer_index": 1,
        "job_index": null,
        "note": "Electrolux washer overflowing, urgent, available today"
    },
    {
        "day_offset": -5,
        "status": "Lost",
        "source": "Phone Call",
        "customer_index": 10,
        "job_index": null,
        "note": "Kenmore oven door not closing properly, customer looking for rough cost"
    },
    {
        "day_offset": -4,
        "status": "Lost",
        "source": "Pro Referral",
        "customer_index": 6,
        "job_index": null,
        "note": "JennAir cooktop burner not lighting, available after 4pm"
    },
    {
        "day_offset": -2,
        "status": "Contacted",
        "source": "Yelp",
        "customer_index": 2,
        "job_index": null,
        "note": "Whirlpool dryer making loud squealing noise, available after 3pm weekdays"
    },
    {
        "day_offset": -1,
        "status": "Contacted",
        "source": "AI Phone",
        "customer_index": 9,
        "job_index": null,
        "note": "Samsung dishwasher not starting cycle, customer wants estimate before scheduling"
    },
    {
        "day_offset": 0,
        "status": "Contacted",
        "source": "Phone Call",
        "customer_index": 4,
        "job_index": null,
        "note": "Sub-Zero freezer not freezing, urgent repair needed this week"
    }
];

const ESTIMATES = [
    {
        "job_index": 20,
        "status": "approved",
        "created_day_offset": -1,
        "accepted_day_offset": 0,
        "accepted_hour": 23,
        "accepted_minute": 30,
        "summary": "Replace the refrigerator ice maker assembly and verify the water supply.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Ice maker assembly", "description": "Samsung refrigerator ice maker assembly", "quantity": 1, "unit": "each", "unit_price": 289, "item_type": "part" },
            { "name": "Installation labor", "description": "Remove failed assembly, install replacement, and test", "quantity": 1, "unit": "service", "unit_price": 185, "item_type": "labor" }
        ],
        "order_list": [
            { "part_number": "DA97-07603B", "part_name": "Refrigerator Ice Maker Assembly", "quantity": 1 }
        ]
    },
    {
        "job_index": 15,
        "status": "approved",
        "created_day_offset": -4,
        "accepted_day_offset": -3,
        "accepted_hour": 16,
        "accepted_minute": 15,
        "summary": "Replace the freezer evaporator fan motor and defrost thermistor.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Evaporator fan motor", "description": "Sub-Zero freezer fan motor", "quantity": 1, "unit": "each", "unit_price": 248, "item_type": "part" },
            { "name": "Defrost thermistor", "description": "Freezer temperature sensor", "quantity": 1, "unit": "each", "unit_price": 94, "item_type": "part" },
            { "name": "Repair labor", "description": "Install parts and verify temperature recovery", "quantity": 2, "unit": "hour", "unit_price": 145, "item_type": "labor" }
        ],
        "order_list": [
            { "part_number": "4200160", "part_name": "Freezer Evaporator Fan Motor", "quantity": 1 },
            { "part_number": "4204150", "part_name": "Defrost Thermistor", "quantity": 1 }
        ]
    },
    {
        "job_index": 13,
        "status": "approved",
        "created_day_offset": -6,
        "accepted_day_offset": -5,
        "accepted_hour": 11,
        "accepted_minute": 45,
        "summary": "Replace the dishwasher drain pump and lower rack wheels.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Drain pump", "description": "GE dishwasher drain pump", "quantity": 1, "unit": "each", "unit_price": 176, "item_type": "part" },
            { "name": "Lower rack wheel assembly", "description": "Whirlpool-style lower rack wheel assembly", "quantity": 2, "unit": "each", "unit_price": 42, "item_type": "part" },
            { "name": "Repair labor", "description": "Install parts and complete leak test", "quantity": 1.5, "unit": "hour", "unit_price": 145, "item_type": "labor" }
        ],
        "order_list": [
            { "part_number": "WD19X25700", "part_name": "Dishwasher Drain Pump", "quantity": 1 },
            { "part_number": "W10195416", "part_name": "Lower Dishrack Wheel Assembly", "quantity": 2 }
        ]
    },
    {
        "job_index": 16,
        "status": "sent",
        "created_day_offset": -2,
        "summary": "Replace the washer drain pump after customer approval.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Drain pump", "description": "Washer drain pump assembly", "quantity": 1, "unit": "each", "unit_price": 168, "item_type": "part" },
            { "name": "Installation labor", "description": "Install pump and run drain cycle", "quantity": 1, "unit": "service", "unit_price": 185, "item_type": "labor" }
        ],
        "order_list": []
    },
    {
        "job_index": 23,
        "status": "draft",
        "created_day_offset": 0,
        "summary": "Diagnose refrigerator compressor noise and prepare repair options.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Diagnostic visit", "description": "Compressor and sealed-system diagnosis", "quantity": 1, "unit": "service", "unit_price": 95, "item_type": "labor" }
        ],
        "order_list": []
    },
    {
        "job_index": 9,
        "status": "declined",
        "created_day_offset": -9,
        "summary": "Replace the washer spin basket and bearing assembly.",
        "tax_rate": 6.25,
        "items": [
            { "name": "Spin basket assembly", "description": "Washer basket and bearing assembly", "quantity": 1, "unit": "each", "unit_price": 412, "item_type": "part" },
            { "name": "Installation labor", "description": "Disassemble tub and install basket assembly", "quantity": 3, "unit": "hour", "unit_price": 145, "item_type": "labor" }
        ],
        "order_list": []
    }
];

const TASKS = [
    {
        "day_offset": 0,
        "status": "open",
        "parent_type": "job",
        "parent_index": 19,
        "description": "Confirm arrival window with the customer"
    },
    {
        "day_offset": 0,
        "status": "open",
        "parent_type": "job",
        "parent_index": 22,
        "description": "Order the replacement control board"
    },
    {
        "day_offset": 0,
        "status": "open",
        "parent_type": "job",
        "parent_index": 20,
        "description": "Send the invoice for today's visit"
    },
    {
        "day_offset": 0,
        "status": "open",
        "parent_type": "lead",
        "parent_index": 37,
        "description": "Call back with a quote"
    },
    {
        "day_offset": 1,
        "status": "open",
        "parent_type": "job",
        "parent_index": 24,
        "description": "Confirm tomorrow's morning slot"
    },
    {
        "day_offset": 1,
        "status": "open",
        "parent_type": "job",
        "parent_index": 13,
        "description": "Chase the parts supplier for an ETA"
    },
    {
        "day_offset": 2,
        "status": "open",
        "parent_type": "job",
        "parent_index": 25,
        "description": "Assign a technician"
    },
    {
        "day_offset": -1,
        "status": "open",
        "parent_type": "job",
        "parent_index": 16,
        "description": "Follow up — customer never returned the call"
    },
    {
        "day_offset": -2,
        "status": "done",
        "parent_type": "job",
        "parent_index": 17,
        "description": "Collect the balance on the completed repair"
    },
    {
        "day_offset": -3,
        "status": "done",
        "parent_type": "job",
        "parent_index": 15,
        "description": "Send the receipt"
    },
    {
        "day_offset": -5,
        "status": "done",
        "parent_type": "lead",
        "parent_index": 30,
        "description": "Qualify the request"
    },
    {
        "day_offset": -7,
        "status": "done",
        "parent_type": "job",
        "parent_index": 10,
        "description": "Close out the work order"
    }
];

module.exports = Object.freeze({
    companyName: 'Northside Appliance Care',
    timezone: 'America/New_York',
    customers: CUSTOMERS,
    technicians: TECHNICIANS,
    services: SERVICES,
    jobs: JOBS,
    leads: LEADS,
    estimates: ESTIMATES,
    tasks: TASKS,
});
