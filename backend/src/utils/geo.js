const EARTH_RADIUS_MILES = 3958.8;

function toRadians(degrees) {
    return Number(degrees) * Math.PI / 180;
}

/**
 * Return the great-circle distance between two latitude/longitude points.
 * Numeric strings are accepted because PostgreSQL NUMERIC values are returned
 * as strings by pg.
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
    const latitude1 = toRadians(lat1);
    const latitude2 = toRadians(lat2);
    const deltaLatitude = toRadians(Number(lat2) - Number(lat1));
    const deltaLongitude = toRadians(Number(lon2) - Number(lon1));

    const sinLatitude = Math.sin(deltaLatitude / 2);
    const sinLongitude = Math.sin(deltaLongitude / 2);
    const a = sinLatitude * sinLatitude
        + Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
    const boundedA = Math.min(1, Math.max(0, a));
    const angularDistance = 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));

    return EARTH_RADIUS_MILES * angularDistance;
}

module.exports = { haversineMiles };
