/**
 * Static US NANPA geography used only for local-first number-search suggestions.
 * In-service codes: NANPA npa_report.csv snapshot 2026-07-13.
 * City/centroid reference: enam-co/go-areacodes (MIT); new overlays inherit
 * their parent overlay geography. Coordinates are approximate centroids.
 */

export interface AreaCode {
    code: string;
    city: string;
    state: string;
    lat: number;
    lon: number;
}

export interface AreaCodeLocale {
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    lat?: number | null;
    lon?: number | null;
}

export type AreaCodeSearchCriterion =
    | { kind: "area_code"; value: string }
    | { kind: "locality"; value: string };

export const AREA_CODES: readonly AreaCode[] = [
    { code: "201", city: "Bayonne", state: "NJ", lat: 40.925692, lon: -74.073135 },
    { code: "202", city: "Washington", state: "DC", lat: 38.904789, lon: -77.016273 },
    { code: "203", city: "Bridgeport", state: "CT", lat: 41.341175, lon: -73.167001 },
    { code: "205", city: "Birmingham", state: "AL", lat: 33.369918, lon: -87.418475 },
    { code: "206", city: "Seattle", state: "WA", lat: 47.56621, lon: -122.395643 },
    { code: "207", city: "Portland", state: "ME", lat: 45.30897, lon: -69.1782 },
    { code: "208", city: "Boise", state: "ID", lat: 44.38906, lon: -114.659367 },
    { code: "209", city: "Lodi", state: "CA", lat: 37.810234, lon: -120.524619 },
    { code: "210", city: "San Antonio", state: "TX", lat: 29.446946, lon: -98.502244 },
    { code: "212", city: "New York City", state: "NY", lat: 40.781428, lon: -73.965434 },
    { code: "213", city: "Los Angeles", state: "CA", lat: 34.049442, lon: -118.266392 },
    { code: "214", city: "Dallas", state: "TX", lat: 32.771888, lon: -96.647071 },
    { code: "215", city: "Levittown", state: "PA", lat: 40.241084, lon: -75.15556 },
    { code: "216", city: "Cleveland", state: "OH", lat: 41.466283, lon: -81.630237 },
    { code: "217", city: "Champaign", state: "IL", lat: 39.787445, lon: -89.339116 },
    { code: "218", city: "Duluth", state: "MN", lat: 47.617058, lon: -94.077273 },
    { code: "219", city: "Gary", state: "IN", lat: 41.167422, lon: -86.10073 },
    { code: "220", city: "Athens", state: "OH", lat: 39.68925, lon: -82.238329 },
    { code: "223", city: "Lancaster", state: "PA", lat: 40.155116, lon: -77.060091 },
    { code: "224", city: "Arlington Heights", state: "IL", lat: 42.195629, lon: -88.103663 },
    { code: "225", city: "Baton Rouge", state: "LA", lat: 30.529115, lon: -91.114891 },
    { code: "227", city: "Silver Spring", state: "MD", lat: 38.990665, lon: -77.026088 },
    { code: "228", city: "Biloxi", state: "MS", lat: 30.498325, lon: -88.990244 },
    { code: "229", city: "Albany", state: "GA", lat: 31.473049, lon: -84.033645 },
    { code: "231", city: "Grant", state: "MI", lat: 44.567455, lon: -85.470799 },
    { code: "234", city: "Akron", state: "OH", lat: 40.909482, lon: -81.309358 },
    { code: "235", city: "Columbia", state: "MO", lat: 37.919598, lon: -91.136288 },
    { code: "239", city: "Cape Coral", state: "FL", lat: 26.069419, lon: -81.419083 },
    { code: "240", city: "Aspen Hill", state: "MD", lat: 39.077466, lon: -77.839196 },
    { code: "248", city: "Farmington Hills", state: "MI", lat: 42.644892, lon: -83.401584 },
    { code: "251", city: "Mobile", state: "AL", lat: 31.216421, lon: -87.652638 },
    { code: "252", city: "Elizabeth City", state: "NC", lat: 35.685581, lon: -76.934414 },
    { code: "253", city: "Kent", state: "WA", lat: 47.215973, lon: -122.433656 },
    { code: "254", city: "Eastland", state: "TX", lat: 31.764308, lon: -97.710172 },
    { code: "256", city: "Decatur", state: "AL", lat: 34.148987, lon: -86.452873 },
    { code: "260", city: "Fort Wayne", state: "IN", lat: 41.093442, lon: -85.241781 },
    { code: "262", city: "Kenosha", state: "WI", lat: 42.950573, lon: -88.283516 },
    { code: "267", city: "Levittown", state: "PA", lat: 40.241084, lon: -75.15556 },
    { code: "269", city: "Allegan", state: "MI", lat: 42.211698, lon: -85.741985 },
    { code: "270", city: "Bowling Green", state: "KY", lat: 37.105285, lon: -88.166884 },
    { code: "272", city: "Back Mountain", state: "PA", lat: 41.329586, lon: -76.0678680461039 },
    { code: "274", city: "Green Bay", state: "WI", lat: 44.519158, lon: -88.019826 },
    { code: "276", city: "Danville", state: "VA", lat: 36.87419, lon: -81.622088 },
    { code: "279", city: "Arden-Arcade", state: "CA", lat: 38.6039613, lon: -121.383003529994 },
    { code: "281", city: "Baytown", state: "TX", lat: 29.837525, lon: -95.377346 },
    { code: "283", city: "Cincinnati", state: "OH", lat: 39.103118, lon: -84.512019 },
    { code: "301", city: "Aspen Hill", state: "MD", lat: 39.077466, lon: -77.839196 },
    { code: "302", city: "Dover", state: "DE", lat: 39.073022, lon: -75.462006 },
    { code: "303", city: "Aurora", state: "CO", lat: 39.713461, lon: -104.82857 },
    { code: "304", city: "Charleston", state: "WV", lat: 38.642574, lon: -80.61372 },
    { code: "305", city: "Miami", state: "FL", lat: 25.300831, lon: -80.856754 },
    { code: "307", city: "Casper", state: "WY", lat: 42.999627, lon: -107.551447 },
    { code: "308", city: "Kearney", state: "NE", lat: 41.454586, lon: -101.145726 },
    { code: "309", city: "Bloomington", state: "IL", lat: 40.802537, lon: -89.95696 },
    { code: "310", city: "Los Angeles", state: "CA", lat: 33.515574, lon: -118.777633 },
    { code: "312", city: "Chicago", state: "IL", lat: 41.873277, lon: -87.645204 },
    { code: "313", city: "Dearborn", state: "MI", lat: 42.345428, lon: -83.146191 },
    { code: "314", city: "Florissant", state: "MO", lat: 38.67023, lon: -90.337973 },
    { code: "315", city: "Syracuse", state: "NY", lat: 43.557021, lon: -75.737581 },
    { code: "316", city: "Wichita", state: "KS", lat: 37.75168, lon: -97.247515 },
    { code: "317", city: "Indianapolis", state: "IN", lat: 39.766543, lon: -86.128131 },
    { code: "318", city: "Bossier City", state: "LA", lat: 32.062174, lon: -92.544682 },
    { code: "319", city: "Cedar Rapids", state: "IA", lat: 42.107799, lon: -91.562776 },
    { code: "320", city: "Alexandria", state: "MN", lat: 45.52735, lon: -94.793149 },
    { code: "321", city: "Melbourne", state: "FL", lat: 28.303802, lon: -81.066529 },
    { code: "323", city: "Los Angeles", state: "CA", lat: 34.037423, lon: -118.254201 },
    { code: "324", city: "Jacksonville", state: "FL", lat: 30.236743, lon: -81.824942 },
    { code: "325", city: "Abilene", state: "TX", lat: 31.544876, lon: -100.102418 },
    { code: "326", city: "Dayton", state: "OH", lat: 39.737478, lon: -83.943091 },
    { code: "327", city: "Jonesboro", state: "AR", lat: 34.729392, lon: -92.083437 },
    { code: "329", city: "Kingston", state: "NY", lat: 41.68195, lon: -74.259071 },
    { code: "330", city: "Akron", state: "OH", lat: 40.909482, lon: -81.309358 },
    { code: "331", city: "Aurora", state: "IL", lat: 41.810713, lon: -88.254341 },
    { code: "332", city: "Manhattan", state: "NY", lat: 40.7900869, lon: -73.9598295 },
    { code: "334", city: "Auburn", state: "AL", lat: 31.748015, lon: -86.710752 },
    { code: "336", city: "Greensboro", state: "NC", lat: 36.165262, lon: -80.203652 },
    { code: "337", city: "Lafayette", state: "LA", lat: 30.363876, lon: -92.68289 },
    { code: "339", city: "Lynn", state: "MA", lat: 42.255792, lon: -70.993819 },
    { code: "340", city: "charlotte amalie", state: "VI", lat: 18.3419, lon: -64.9307 },
    { code: "341", city: "Oakland", state: "CA", lat: 37.804363, lon: -122.271113 },
    { code: "346", city: "Alvin", state: "TX", lat: 29.4238472, lon: -95.2441009 },
    { code: "347", city: "Bronx", state: "NY", lat: 40.685997, lon: -73.935788 },
    { code: "350", city: "Lodi", state: "CA", lat: 37.810234, lon: -120.524619 },
    { code: "351", city: "Haverhill", state: "MA", lat: 42.587448, lon: -71.595462 },
    { code: "352", city: "Gainesville", state: "FL", lat: 29.166672, lon: -82.335163 },
    { code: "353", city: "Janesville", state: "WI", lat: 43.376417, lon: -90.232246 },
    { code: "357", city: "Clovis", state: "CA", lat: 36.600669, lon: -119.378031 },
    { code: "360", city: "Bellingham", state: "WA", lat: 47.453869, lon: -122.407745 },
    { code: "361", city: "Corpus Christi", state: "TX", lat: 28.075417, lon: -97.67658 },
    { code: "363", city: "Freeport", state: "NY", lat: 40.750917, lon: -73.398233 },
    { code: "364", city: "Owensboro", state: "KY", lat: 37.105285, lon: -88.166884 },
    { code: "369", city: "santa rosa", state: "CA", lat: 38.440429, lon: -122.714054 },
    { code: "380", city: "Columbus", state: "OH", lat: 39.961175, lon: -82.998794 },
    { code: "385", city: "Ogden", state: "UT", lat: 40.617162, lon: -111.805673 },
    { code: "386", city: "Daytona Beach", state: "FL", lat: 29.755314, lon: -82.175609 },
    { code: "401", city: "Cranston", state: "RI", lat: 41.604967, lon: -71.5344 },
    { code: "402", city: "Columbus", state: "NE", lat: 41.623995, lon: -98.025861 },
    { code: "404", city: "Atlanta", state: "GA", lat: 33.739497, lon: -84.392472 },
    { code: "405", city: "Midwest City", state: "OK", lat: 35.390576, lon: -97.472448 },
    { code: "406", city: "Billings", state: "MT", lat: 47.033533, lon: -109.64515 },
    { code: "407", city: "Altamonte Springs", state: "FL", lat: 28.325064, lon: -81.22196 },
    { code: "408", city: "Gilroy", state: "CA", lat: 37.227493, lon: -121.70066 },
    { code: "409", city: "Beaumont", state: "TX", lat: 30.323281, lon: -94.291657 },
    { code: "410", city: "Annapolis", state: "MD", lat: 38.896232, lon: -76.110627 },
    { code: "412", city: "Pittsburgh", state: "PA", lat: 40.432942, lon: -79.975833 },
    { code: "413", city: "Chicopee", state: "MA", lat: 42.352791, lon: -72.831601 },
    { code: "414", city: "Milwaukee", state: "WI", lat: 42.996968, lon: -87.976898 },
    { code: "415", city: "San Francisco", state: "CA", lat: 37.986719, lon: -122.679559 },
    { code: "417", city: "Springfield", state: "MO", lat: 37.216256, lon: -93.181131 },
    { code: "419", city: "Toledo", state: "OH", lat: 40.998598, lon: -83.55333 },
    { code: "423", city: "Chattanooga", state: "TN", lat: 35.883792, lon: -83.924438 },
    { code: "424", city: "Beverly Hills", state: "CA", lat: 33.515574, lon: -118.777633 },
    { code: "425", city: "Bellevue", state: "WA", lat: 47.570178, lon: -121.886616 },
    { code: "430", city: "Longview", state: "TX", lat: 32.705051, lon: -95.389774 },
    { code: "432", city: "Midland", state: "TX", lat: 30.879595, lon: -102.924163 },
    { code: "434", city: "Lynchburg", state: "VA", lat: 37.184108, lon: -78.597018 },
    { code: "435", city: "Cedar City", state: "UT", lat: 39.306817, lon: -111.718184 },
    { code: "436", city: "Cleveland", state: "OH", lat: 41.483337, lon: -81.422584 },
    { code: "440", city: "Cleveland", state: "OH", lat: 41.483337, lon: -81.422584 },
    { code: "442", city: "Apple Valley", state: "CA", lat: 34.500831, lon: -117.185875 },
    { code: "443", city: "Baltimore", state: "MD", lat: 38.896232, lon: -76.110627 },
    { code: "445", city: "Philadelphia", state: "PA", lat: 40.241084, lon: -75.15556 },
    { code: "447", city: "Champaign", state: "IL", lat: 40.11642, lon: -88.243382 },
    { code: "448", city: "Pensacola", state: "FL", lat: 30.35353, lon: -85.304696 },
    { code: "457", city: "Bossier City", state: "LA", lat: 32.062174, lon: -92.544682 },
    { code: "458", city: "Eugene", state: "OR", lat: 44.052069, lon: -123.086753 },
    { code: "463", city: "Carmel", state: "IN", lat: 39.9788383, lon: -86.118731 },
    { code: "464", city: "Cicero", state: "IL", lat: 41.845587, lon: -87.753944 },
    { code: "465", city: "Bellerose", state: "NY", lat: 40.685997, lon: -73.935788 },
    { code: "469", city: "Carrollton", state: "TX", lat: 32.771888, lon: -96.647071 },
    { code: "470", city: "Atlanta", state: "GA", lat: 33.770793, lon: -84.43614 },
    { code: "471", city: "Starkville", state: "MS", lat: 33.836267, lon: -89.621696 },
    { code: "472", city: "Fayetteville", state: "NC", lat: 34.75927, lon: -78.576525 },
    { code: "475", city: "Bridgeport", state: "CT", lat: 41.341175, lon: -73.167001 },
    { code: "478", city: "Macon", state: "GA", lat: 32.689186, lon: -83.214208 },
    { code: "479", city: "Fayetteville", state: "AR", lat: 35.523174, lon: -93.859516 },
    { code: "480", city: "Chandler", state: "AZ", lat: 33.486401, lon: -111.758833 },
    { code: "483", city: "Auburn", state: "AL", lat: 31.748015, lon: -86.710752 },
    { code: "484", city: "Allentown", state: "PA", lat: 40.341781, lon: -75.643876 },
    { code: "501", city: "Little Rock", state: "AR", lat: 35.26111, lon: -93.193786 },
    { code: "502", city: "Louisville", state: "KY", lat: 38.215905, lon: -85.235416 },
    { code: "503", city: "Beaver", state: "OR", lat: 45.318736, lon: -122.916239 },
    { code: "504", city: "Kenner", state: "LA", lat: 29.865363, lon: -89.655576 },
    { code: "505", city: "Albuquerque", state: "NM", lat: 35.568629, lon: -107.451999 },
    { code: "507", city: "Austin", state: "MN", lat: 44.040521, lon: -94.170011 },
    { code: "508", city: "Cambridge", state: "MA", lat: 41.857075, lon: -70.96184 },
    { code: "509", city: "Kennewick", state: "WA", lat: 47.358864, lon: -119.06016 },
    { code: "510", city: "Alameda", state: "CA", lat: 37.737405, lon: -122.08967 },
    { code: "512", city: "Austin", state: "TX", lat: 30.471944, lon: -97.726481 },
    { code: "513", city: "Cincinnati", state: "OH", lat: 39.268072, lon: -84.3669 },
    { code: "515", city: "Ames", state: "IA", lat: 42.236267, lon: -93.927577 },
    { code: "516", city: "Freeport", state: "NY", lat: 40.750917, lon: -73.398233 },
    { code: "517", city: "Charlotte", state: "MI", lat: 42.275676, lon: -84.503319 },
    { code: "518", city: "Albany", state: "NY", lat: 43.562173, lon: -73.985656 },
    { code: "520", city: "Casas Adobes", state: "AZ", lat: 34.325295, lon: -111.667117 },
    { code: "530", city: "Chico", state: "CA", lat: 40.434209, lon: -121.560896 },
    { code: "531", city: "Omaha", state: "NE", lat: 41.252363, lon: -95.997988 },
    { code: "534", city: "Eau Claire", state: "WI", lat: 44.811349, lon: -91.498494 },
    { code: "539", city: "Bartlesville", state: "OK", lat: 36.7494864, lon: -95.9782966 },
    { code: "540", city: "Blacksburg", state: "VA", lat: 38.057324, lon: -79.036418 },
    { code: "541", city: "Bend", state: "OR", lat: 43.793004, lon: -120.305909 },
    { code: "551", city: "Bayonne", state: "NJ", lat: 40.925692, lon: -74.073135 },
    { code: "557", city: "St. Louis", state: "MO", lat: 38.627002, lon: -90.199404 },
    { code: "559", city: "Clovis", state: "CA", lat: 36.600669, lon: -119.378031 },
    { code: "561", city: "Boca Raton", state: "FL", lat: 26.640771, lon: -80.448011 },
    { code: "562", city: "Bellflower", state: "CA", lat: 33.88048, lon: -118.093193 },
    { code: "563", city: "Davenport", state: "IA", lat: 42.528086, lon: -91.230288 },
    { code: "564", city: "Seattle", state: "WA", lat: 47.606209, lon: -122.33207 },
    { code: "567", city: "Toledo", state: "OH", lat: 40.998598, lon: -83.55333 },
    { code: "570", city: "Scranton", state: "PA", lat: 41.340957, lon: -76.360915 },
    { code: "571", city: "Alexandria", state: "VA", lat: 38.837375, lon: -77.397635 },
    { code: "572", city: "Midwest City", state: "OK", lat: 35.390576, lon: -97.472448 },
    { code: "573", city: "Columbia", state: "MO", lat: 37.919598, lon: -91.136288 },
    { code: "574", city: "Elkhart", state: "IN", lat: 41.248048, lon: -86.279023 },
    { code: "575", city: "Alamogordo", state: "NM", lat: 34.116084, lon: -105.750853 },
    { code: "580", city: "Lawton", state: "OK", lat: 35.509837, lon: -98.495317 },
    { code: "582", city: "Erie", state: "PA", lat: 41.113357, lon: -78.776102 },
    { code: "585", city: "Arcade", state: "NY", lat: 42.757073, lon: -77.977995 },
    { code: "586", city: "Sterling Heights", state: "MI", lat: 42.707104, lon: -82.901231 },
    { code: "601", city: "Hattiesburg", state: "MS", lat: 31.765804, lon: -89.761592 },
    { code: "602", city: "Phoenix", state: "AZ", lat: 33.487025, lon: -112.076198 },
    { code: "603", city: "Dover", state: "NH", lat: 43.745418, lon: -71.547951 },
    { code: "605", city: "Rapid City", state: "SD", lat: 44.436144, lon: -100.230488 },
    { code: "606", city: "Ashland", state: "KY", lat: 37.540083, lon: -83.597956 },
    { code: "607", city: "Elmira", state: "NY", lat: 42.335268, lon: -76.075461 },
    { code: "608", city: "Janesville", state: "WI", lat: 43.376417, lon: -90.232246 },
    { code: "609", city: "Allentown", state: "NJ", lat: 39.784621, lon: -74.657517 },
    { code: "610", city: "Allentown", state: "PA", lat: 40.341781, lon: -75.643876 },
    { code: "612", city: "Minneapolis", state: "MN", lat: 44.929252, lon: -93.25642 },
    { code: "614", city: "Columbus", state: "OH", lat: 39.966582, lon: -83.036841 },
    { code: "615", city: "Murfreesboro", state: "TN", lat: 36.175352, lon: -86.556462 },
    { code: "616", city: "Grand Rapids", state: "MI", lat: 42.981195, lon: -85.608166 },
    { code: "617", city: "Boston", state: "MA", lat: 42.319045, lon: -71.093525 },
    { code: "618", city: "Alton", state: "IL", lat: 38.329447, lon: -89.014305 },
    { code: "619", city: "Chula Vista", state: "CA", lat: 32.745454, lon: -116.727701 },
    { code: "620", city: "Dodge City", state: "KS", lat: 37.767537, lon: -98.48193 },
    { code: "621", city: "Houston", state: "TX", lat: 29.837525, lon: -95.377346 },
    { code: "623", city: "Phoenix", state: "AZ", lat: 33.545877, lon: -112.452827 },
    { code: "624", city: "Cattaraugus", state: "NY", lat: 42.655359, lon: -78.3959 },
    { code: "626", city: "Alhambra", state: "CA", lat: 34.108144, lon: -117.98469 },
    { code: "628", city: "San Francisco", state: "CA", lat: 37.774929, lon: -122.419415 },
    { code: "629", city: "Brentwood", state: "TN", lat: 36.0325687, lon: -86.7825235 },
    { code: "630", city: "Naperville", state: "IL", lat: 41.810713, lon: -88.254341 },
    { code: "631", city: "Babylon", state: "NY", lat: 40.946958, lon: -72.725587 },
    { code: "636", city: "St. Charles", state: "MO", lat: 38.578392, lon: -90.797942 },
    { code: "640", city: "Allentown", state: "NJ", lat: 39.784621, lon: -74.657517 },
    { code: "641", city: "Mason City", state: "IA", lat: 41.800221, lon: -93.234162 },
    { code: "645", city: "Miami", state: "FL", lat: 25.300831, lon: -80.856754 },
    { code: "646", city: "New York City", state: "NY", lat: 40.781428, lon: -73.965434 },
    { code: "650", city: "Daly City", state: "CA", lat: 37.415331, lon: -122.302585 },
    { code: "651", city: "St. Paul", state: "MN", lat: 44.915292, lon: -92.841185 },
    { code: "656", city: "Tampa", state: "FL", lat: 28.006915, lon: -82.355531 },
    { code: "657", city: "Anaheim", state: "CA", lat: 33.806316, lon: -117.829679 },
    { code: "659", city: "Birmingham", state: "AL", lat: 33.52066, lon: -86.802489 },
    { code: "660", city: "Marshall", state: "MO", lat: 39.647249, lon: -93.383421 },
    { code: "661", city: "Earlimart", state: "CA", lat: 35.075115, lon: -118.902121 },
    { code: "662", city: "Starkville", state: "MS", lat: 33.836267, lon: -89.621696 },
    { code: "667", city: "Baltimore", state: "MD", lat: 39.290384, lon: -76.612189 },
    { code: "669", city: "San Jose", state: "CA", lat: 37.338208, lon: -121.886328 },
    { code: "670", city: "saipan", state: "MP", lat: 15.177801, lon: 145.750967 },
    { code: "671", city: "Hagatna", state: "GU", lat: 13.44733, lon: 144.767979 },
    { code: "678", city: "Atlanta", state: "GA", lat: 33.770793, lon: -84.43614 },
    { code: "679", city: "Detroit", state: "MI", lat: 42.331427, lon: -83.045753 },
    { code: "680", city: "Auburn", state: "NY", lat: 42.9320202, lon: -76.5672029 },
    { code: "681", city: "Charleston", state: "WV", lat: 38.349819, lon: -81.632623 },
    { code: "682", city: "Arlington", state: "TX", lat: 32.655169, lon: -97.488648 },
    { code: "684", city: "Pago Pago", state: "AS", lat: -14.266062, lon: -170.130305 },
    { code: "686", city: "Mechanicsville", state: "VA", lat: 37.425718, lon: -77.980823 },
    { code: "689", city: "Orlando", state: "FL", lat: 28.538335, lon: -81.379236 },
    { code: "701", city: "Bismarck", state: "ND", lat: 47.446324, lon: -100.469297 },
    { code: "702", city: "Henderson", state: "NV", lat: 36.159086, lon: -114.938366 },
    { code: "703", city: "Alexandria", state: "VA", lat: 38.837375, lon: -77.397635 },
    { code: "704", city: "Charlotte", state: "NC", lat: 35.343951, lon: -80.734736 },
    { code: "706", city: "Athens", state: "GA", lat: 33.700602, lon: -83.870619 },
    { code: "707", city: "Benicia", state: "CA", lat: 39.887445, lon: -123.19922 },
    { code: "708", city: "Berwyn", state: "IL", lat: 41.559062, lon: -87.748494 },
    { code: "712", city: "Council Bluffs", state: "IA", lat: 42.23012, lon: -95.418361 },
    { code: "713", city: "Houston", state: "TX", lat: 29.837525, lon: -95.377346 },
    { code: "714", city: "Anaheim", state: "CA", lat: 33.806316, lon: -117.829679 },
    { code: "715", city: "Chippewa Falls", state: "WI", lat: 45.417223, lon: -90.43033 },
    { code: "716", city: "Cattaraugus", state: "NY", lat: 42.655359, lon: -78.3959 },
    { code: "717", city: "Lancaster", state: "PA", lat: 40.155116, lon: -77.060091 },
    { code: "718", city: "Bellerose", state: "NY", lat: 40.685997, lon: -73.935788 },
    { code: "719", city: "Alamosa", state: "CO", lat: 38.164629, lon: -104.339161 },
    { code: "720", city: "Boulder", state: "CO", lat: 39.713461, lon: -104.82857 },
    { code: "724", city: "New Castle", state: "PA", lat: 40.529223, lon: -79.871479 },
    { code: "725", city: "Henderson", state: "NV", lat: 36.0391456, lon: -114.9819235 },
    { code: "726", city: "San Antonio", state: "TX", lat: 29.4246002, lon: -98.4951405 },
    { code: "727", city: "Clearwater", state: "FL", lat: 28.028726, lon: -82.692597 },
    { code: "728", city: "Boca Raton", state: "FL", lat: 26.640771, lon: -80.448011 },
    { code: "729", city: "Chattanooga", state: "TN", lat: 35.883792, lon: -83.924438 },
    { code: "730", city: "Alton", state: "IL", lat: 38.890603, lon: -90.184276 },
    { code: "731", city: "Jackson", state: "TN", lat: 35.791081, lon: -88.774074 },
    { code: "732", city: "Brick Township", state: "NJ", lat: 40.260509, lon: -74.294553 },
    { code: "734", city: "Ann Arbor", state: "MI", lat: 42.146633, lon: -83.671962 },
    { code: "737", city: "Austin", state: "TX", lat: 30.267153, lon: -97.74306 },
    { code: "738", city: "Los Angeles", state: "CA", lat: 34.049442, lon: -118.266392 },
    { code: "740", city: "Athens", state: "OH", lat: 39.68925, lon: -82.238329 },
    { code: "743", city: "Greensboro", state: "NC", lat: 36.0726355, lon: -79.7919754 },
    { code: "747", city: "Burbank", state: "CA", lat: 34.180839, lon: -118.308966 },
    { code: "748", city: "Durango", state: "CO", lat: 39.516547, lon: -106.512204 },
    { code: "754", city: "Coral Springs", state: "FL", lat: 26.150138, lon: -80.486696 },
    { code: "757", city: "Chesapeake", state: "VA", lat: 37.178366, lon: -76.300123 },
    { code: "760", city: "Apple Valley", state: "CA", lat: 35.077329, lon: -116.569262 },
    { code: "762", city: "Athens", state: "GA", lat: 33.700602, lon: -83.870619 },
    { code: "763", city: "Brooklyn Park", state: "MN", lat: 45.322976, lon: -93.54338 },
    { code: "765", city: "Kokomo", state: "IN", lat: 40.097063, lon: -86.177642 },
    { code: "769", city: "Hattiesburg", state: "MS", lat: 31.765804, lon: -89.761592 },
    { code: "770", city: "Atlanta", state: "GA", lat: 33.777593, lon: -84.447258 },
    { code: "771", city: "Washington", state: "DC", lat: 38.904789, lon: -77.016273 },
    { code: "772", city: "Port St. Lucie", state: "FL", lat: 27.310037, lon: -80.462545 },
    { code: "773", city: "Chicago", state: "IL", lat: 41.826251, lon: -87.675835 },
    { code: "774", city: "Brockton", state: "MA", lat: 41.857075, lon: -70.96184 },
    { code: "775", city: "Carson City", state: "NV", lat: 39.568474, lon: -116.769254 },
    { code: "779", city: "Joliet", state: "IL", lat: 41.605203, lon: -88.918992 },
    { code: "781", city: "Lynn", state: "MA", lat: 42.255792, lon: -70.993819 },
    { code: "785", city: "Abilene", state: "KS", lat: 39.254088, lon: -98.504536 },
    { code: "786", city: "Hialeah", state: "FL", lat: 25.603078, lon: -80.532102 },
    { code: "787", city: "San Juan", state: "PR", lat: 18.4655, lon: -66.1057 },
    { code: "801", city: "Ogden", state: "UT", lat: 40.617162, lon: -111.805673 },
    { code: "802", city: "Bennington", state: "VT", lat: 44.075223, lon: -72.662746 },
    { code: "803", city: "Columbia", state: "SC", lat: 33.894777, lon: -81.061539 },
    { code: "804", city: "Mechanicsville", state: "VA", lat: 37.425718, lon: -77.980823 },
    { code: "805", city: "Camarillo", state: "CA", lat: 34.953333, lon: -120.148748 },
    { code: "806", city: "Amarillo", state: "TX", lat: 34.662259, lon: -101.598817 },
    { code: "808", city: "Honolulu", state: "HI", lat: 20.663335, lon: -157.330668 },
    { code: "810", city: "Flint", state: "MI", lat: 42.982601, lon: -83.195787 },
    { code: "812", city: "Bloomington", state: "IN", lat: 38.738487, lon: -86.516889 },
    { code: "813", city: "Tampa", state: "FL", lat: 28.006915, lon: -82.355531 },
    { code: "814", city: "Erie", state: "PA", lat: 41.113357, lon: -78.776102 },
    { code: "815", city: "Joliet", state: "IL", lat: 41.605203, lon: -88.918992 },
    { code: "816", city: "Kansas City", state: "MO", lat: 39.305594, lon: -94.409307 },
    { code: "817", city: "Arlington", state: "TX", lat: 32.655169, lon: -97.488648 },
    { code: "818", city: "Agoura Hills", state: "CA", lat: 34.246629, lon: -118.38236 },
    { code: "820", city: "Camarillo", state: "CA", lat: 34.2164099, lon: -119.0376573 },
    { code: "821", city: "Greenville", state: "SC", lat: 34.597028, lon: -82.268514 },
    { code: "826", city: "Blacksburg", state: "VA", lat: 38.057324, lon: -79.036418 },
    { code: "828", city: "Asheville", state: "NC", lat: 35.565318, lon: -82.543935 },
    { code: "830", city: "Medina", state: "TX", lat: 29.405036, lon: -99.279701 },
    { code: "831", city: "Salinas", state: "CA", lat: 36.517724, lon: -121.279329 },
    { code: "832", city: "Baytown", state: "TX", lat: 29.837525, lon: -95.377346 },
    { code: "835", city: "Allentown", state: "PA", lat: 40.341781, lon: -75.643876 },
    { code: "837", city: "Chico", state: "CA", lat: 40.434209, lon: -121.560896 },
    { code: "838", city: "Albany", state: "NY", lat: 42.6511674, lon: -73.754968 },
    { code: "839", city: "Columbia", state: "SC", lat: 34.0007493, lon: -81.0343313 },
    { code: "840", city: "Anaheim", state: "CA", lat: 34.10515, lon: -117.298597 },
    { code: "843", city: "Charleston", state: "SC", lat: 33.551999, lon: -80.080251 },
    { code: "845", city: "Kingston", state: "NY", lat: 41.68195, lon: -74.259071 },
    { code: "847", city: "Arlington Heights", state: "IL", lat: 42.195629, lon: -88.103663 },
    { code: "848", city: "Brick Township", state: "NJ", lat: 40.260509, lon: -74.294553 },
    { code: "850", city: "Pensacola", state: "FL", lat: 30.35353, lon: -85.304696 },
    { code: "854", city: "Charleston", state: "SC", lat: 32.7876012, lon: -79.9402728 },
    { code: "856", city: "Camden", state: "NJ", lat: 39.597545, lon: -75.137975 },
    { code: "857", city: "Boston", state: "MA", lat: 42.319045, lon: -71.093525 },
    { code: "858", city: "San Diego", state: "CA", lat: 32.930564, lon: -117.134845 },
    { code: "859", city: "Lexington", state: "KY", lat: 38.19049, lon: -84.492289 },
    { code: "860", city: "Bristol", state: "CT", lat: 41.684526, lon: -72.617608 },
    { code: "861", city: "Bloomington", state: "IL", lat: 40.802537, lon: -89.95696 },
    { code: "862", city: "Clifton", state: "NJ", lat: 41.006143, lon: -74.52237 },
    { code: "863", city: "Lakeland", state: "FL", lat: 27.325409, lon: -81.391146 },
    { code: "864", city: "Greenville", state: "SC", lat: 34.597028, lon: -82.268514 },
    { code: "865", city: "Knoxville", state: "TN", lat: 35.931336, lon: -83.90434 },
    { code: "870", city: "Jonesboro", state: "AR", lat: 34.729392, lon: -92.083437 },
    { code: "872", city: "Chicago", state: "IL", lat: 41.878113, lon: -87.629798 },
    { code: "878", city: "Pittsburgh", state: "PA", lat: 40.523255, lon: -79.878626 },
    { code: "901", city: "Memphis", state: "TN", lat: 35.264514, lon: -89.686114 },
    { code: "903", city: "Longview", state: "TX", lat: 32.705051, lon: -95.389774 },
    { code: "904", city: "Jacksonville", state: "FL", lat: 30.236743, lon: -81.824942 },
    { code: "906", city: "Sault Ste Marie", state: "MI", lat: 46.534917, lon: -87.28168 },
    { code: "907", city: "Anchorage", state: "AK", lat: 58.127197, lon: -48.192896 },
    { code: "908", city: "Washington Township", state: "NJ", lat: 40.69626, lon: -74.815628 },
    { code: "909", city: "Anaheim", state: "CA", lat: 34.10515, lon: -117.298597 },
    { code: "910", city: "Fayetteville", state: "NC", lat: 34.75927, lon: -78.576525 },
    { code: "912", city: "Savannah", state: "GA", lat: 31.668541, lon: -82.04476 },
    { code: "913", city: "Kansas City", state: "KS", lat: 38.895648, lon: -94.985871 },
    { code: "914", city: "Mount Vernon", state: "NY", lat: 41.155343, lon: -73.749733 },
    { code: "915", city: "El Paso", state: "TX", lat: 31.51532, lon: -105.177627 },
    { code: "916", city: "Elk Grove", state: "CA", lat: 38.575174, lon: -121.35713 },
    { code: "917", city: "New York City", state: "NY", lat: 40.685997, lon: -73.935788 },
    { code: "918", city: "Broken Arrow", state: "OK", lat: 35.820098, lon: -95.585892 },
    { code: "919", city: "Cary", state: "NC", lat: 35.763046, lon: -78.665239 },
    { code: "920", city: "Appleton", state: "WI", lat: 44.203386, lon: -88.282572 },
    { code: "924", city: "Austin", state: "MN", lat: 44.040521, lon: -94.170011 },
    { code: "925", city: "Antioch", state: "CA", lat: 37.831956, lon: -121.839538 },
    { code: "928", city: "Flagstaff", state: "AZ", lat: 34.795062, lon: -111.803747 },
    { code: "929", city: "Bellerose", state: "NY", lat: 40.724269, lon: -73.7151313 },
    { code: "930", city: "Bloomington", state: "IN", lat: 39.1670396, lon: -86.5342881 },
    { code: "931", city: "Clarksville", state: "TN", lat: 35.752962, lon: -86.542593 },
    { code: "934", city: "Babylon", state: "NY", lat: 40.74123595, lon: -73.356691165361 },
    { code: "936", city: "Huntsville", state: "TX", lat: 30.988685, lon: -95.077769 },
    { code: "937", city: "Dayton", state: "OH", lat: 39.737478, lon: -83.943091 },
    { code: "938", city: "Huntsville", state: "AL", lat: 34.730368, lon: -86.586103 },
    { code: "939", city: "San Juan", state: "PR", lat: 18.4655, lon: -66.1057 },
    { code: "940", city: "Denton", state: "TX", lat: 33.567916, lon: -98.775843 },
    { code: "941", city: "Sarasota", state: "FL", lat: 26.49156, lon: -81.666428 },
    { code: "943", city: "Atlanta", state: "GA", lat: 33.770793, lon: -84.43614 },
    { code: "945", city: "Carrollton", state: "TX", lat: 32.771888, lon: -96.647071 },
    { code: "947", city: "Farmington Hills", state: "MI", lat: 42.644892, lon: -83.401584 },
    { code: "948", city: "Chesapeake", state: "VA", lat: 37.178366, lon: -76.300123 },
    { code: "949", city: "Costa Mesa", state: "CA", lat: 33.583881, lon: -117.662376 },
    { code: "951", city: "Corona", state: "CA", lat: 33.725159, lon: -117.067767 },
    { code: "952", city: "Bloomington", state: "MN", lat: 44.748131, lon: -93.595425 },
    { code: "954", city: "Fort Lauderdale", state: "FL", lat: 26.150138, lon: -80.486696 },
    { code: "956", city: "Laredo", state: "TX", lat: 27.029143, lon: -98.567131 },
    { code: "959", city: "Hartford", state: "CT", lat: 41.684526, lon: -72.617608 },
    { code: "970", city: "Durango", state: "CO", lat: 39.516547, lon: -106.512204 },
    { code: "971", city: "Beaverton", state: "OR", lat: 45.196065, lon: -122.70783 },
    { code: "972", city: "Carrollton", state: "TX", lat: 32.771888, lon: -96.647071 },
    { code: "973", city: "Newark", state: "NJ", lat: 41.006143, lon: -74.52237 },
    { code: "975", city: "Kansas City", state: "MO", lat: 39.099727, lon: -94.578567 },
    { code: "978", city: "Haverhill", state: "MA", lat: 42.587448, lon: -71.595462 },
    { code: "979", city: "Bryan", state: "TX", lat: 29.834233, lon: -96.309235 },
    { code: "980", city: "Charlotte", state: "NC", lat: 35.343951, lon: -80.734736 },
    { code: "983", city: "Aurora", state: "CO", lat: 39.713461, lon: -104.82857 },
    { code: "984", city: "Raleigh", state: "NC", lat: 35.779589, lon: -78.638178 },
    { code: "985", city: "Hammond", state: "LA", lat: 29.898815, lon: -90.319067 },
    { code: "986", city: "Boise", state: "ID", lat: 43.61656, lon: -116.200835 },
    { code: "989", city: "Alma", state: "MI", lat: 44.097502, lon: -84.120784 },
];

const MAX_SUGGESTIONS = 8;
const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
    return degrees * Math.PI / 180;
}

function distanceKm(origin: { lat: number; lon: number }, areaCode: AreaCode): number {
    const latitudeDelta = toRadians(areaCode.lat - origin.lat);
    const longitudeDelta = toRadians(areaCode.lon - origin.lon);
    const originLatitude = toRadians(origin.lat);
    const areaCodeLatitude = toRadians(areaCode.lat);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(originLatitude) * Math.cos(areaCodeLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function localAreaCodes(locale: AreaCodeLocale | null | undefined): AreaCode[] {
    if (Number.isFinite(locale?.lat) && Number.isFinite(locale?.lon)) {
        const origin = { lat: Number(locale?.lat), lon: Number(locale?.lon) };
        return [...AREA_CODES]
            .sort((a, b) => distanceKm(origin, a) - distanceKm(origin, b) || a.code.localeCompare(b.code))
            .slice(0, MAX_SUGGESTIONS);
    }

    const state = locale?.state?.trim().toUpperCase();
    if (!state) return [];
    return AREA_CODES
        .filter(areaCode => areaCode.state === state)
        .sort((a, b) => a.city.localeCompare(b.city) || a.code.localeCompare(b.code));
}

export function suggestAreaCodes(
    query: string,
    locale: AreaCodeLocale | null | undefined,
): AreaCode[] {
    const local = localAreaCodes(locale);
    const normalized = query.trim().toLowerCase();
    if (!normalized) return local.slice(0, MAX_SUGGESTIONS);

    if (/^\d{1,3}$/.test(normalized)) {
        return local.filter(areaCode => areaCode.code.startsWith(normalized)).slice(0, MAX_SUGGESTIONS);
    }

    return local
        .filter(areaCode => areaCode.city.toLowerCase().startsWith(normalized))
        .slice(0, MAX_SUGGESTIONS);
}

export function formatAreaCode(areaCode: AreaCode): string {
    return `${areaCode.code} — ${areaCode.city}, ${areaCode.state}`;
}

export function detectSearchKind(
    input: string,
    selected: AreaCode | null = null,
): AreaCodeSearchCriterion | null {
    if (selected) return { kind: "area_code", value: selected.code };

    const value = input.trim();
    if (!value) return null;

    /*
     * Spec erratum (owner ruling, 2026-07-13): TELEPHONY-WIZARD-UX-001 §3.2
     * called every other non-empty input a locality. TC-WIZ-024 wins: a 1- or
     * 2-digit value is an incomplete area code and emits no search criterion.
     */
    if (/^\d+$/.test(value)) {
        return value.length === 3 ? { kind: "area_code", value } : null;
    }

    return { kind: "locality", value };
}
