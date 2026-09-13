// Rendering-only photometry for curated destinations missing these fields.
// HYG v4.1 snapshot: public/data/hyg-stars-v41.{json,bin}, CC BY-SA 4.0.
// https://github.com/astronexus/HYG-Database
// Temperature is the catalog's B-V estimate. Visual apparent magnitudes are
// anchored at Sol using each destination's existing distance; physical records
// and radii are unchanged. smoke-realism-data.mjs verifies every copied value.
export const CURATED_PHOTOMETRY = {
    "PROXIMA": { hygIndex:70664, sourceName:"Proxima Centauri", tempK:3383, mag:11.01 },
    "ALPHA CEN A": { hygIndex:71454, sourceName:"Rigil Kentaurus", tempK:5568, mag:-0.01 },
    "BARNARD": { hygIndex:87663, sourceName:"Barnard's Star", tempK:3691, mag:9.54 },
    "WOLF 359": { hygIndex:118714, sourceName:"Wolf 359", tempK:3169, mag:13.45 },
    "SIRIUS A": { hygIndex:32262, sourceName:"Sirius", tempK:10014, mag:-1.44 },
    "EPSILON ERIDANI": { hygIndex:16495, sourceName:"Ran", tempK:5048, mag:3.72 },
    "TAU CETI": { hygIndex:8086, sourceName:"52Tau Cet", tempK:5511, mag:3.49 },
    "VEGA": { hygIndex:90977, sourceName:"Vega", tempK:10138, mag:0.03 },
    "ALPHA CEN B": { hygIndex:71451, sourceName:"Toliman", tempK:4996, mag:1.35 },
    "LALANDE 21185": { hygIndex:53878, sourceName:"Lalande 21185", tempK:3791, mag:7.49 },
    "ROSS 154": { hygIndex:92113, sourceName:"Ross 154", tempK:3779, mag:10.37 },
    "ROSS 248": { hygIndex:119579, sourceName:"Ross 248", tempK:3277, mag:12.29 },
    "LACAILLE 9352": { hygIndex:113685, sourceName:"Lacaille 9352", tempK:3819, mag:7.35 },
    "ROSS 128": { hygIndex:57373, sourceName:"Ross 128", tempK:3457, mag:11.12 },
    "PROCYON A": { hygIndex:37172, sourceName:"Procyon", tempK:6714, mag:0.4 },
    "61 CYGNI A": { hygIndex:103877, sourceName:"61    Cyg", tempK:4583, mag:5.2 },
    "61 CYGNI B": { hygIndex:103881, sourceName:"61    Cyg", tempK:4105, mag:6.05 },
    "GROOMBRIDGE 34 A": { hygIndex:1471, sourceName:"Groombridge 34", tempK:3705, mag:8.09 },
    "EPSILON INDI A": { hygIndex:108524, sourceName:"Eps Ind", tempK:4612, mag:4.69 },
    "KAPTEYN": { hygIndex:24128, sourceName:"Kapteyn's Star", tempK:3730, mag:8.86 },
    "VAN MAANEN": { hygIndex:3819, sourceName:"Van Maanen's Star", tempK:6154, mag:12.37 },
    "ALTAIR": { hygIndex:97336, sourceName:"Altair", tempK:8004, mag:0.76 },
    "FOMALHAUT": { hygIndex:113006, sourceName:"Fomalhaut", tempK:8615, mag:1.17 },
    "ARCTURUS": { hygIndex:69449, sourceName:"Arcturus", tempK:4234, mag:-0.05 },
    "CAPELLA": { hygIndex:24548, sourceName:"Capella", tempK:5296, mag:0.08 },
    "ALDEBARAN": { hygIndex:21367, sourceName:"Aldebaran", tempK:3737, mag:0.87 },
    "REGULUS": { hygIndex:49527, sourceName:"Regulus", tempK:11359, mag:1.36 },
    "SPICA": { hygIndex:65267, sourceName:"Spica", tempK:14492, mag:0.98 },
    "POLARIS": { hygIndex:11733, sourceName:"Polaris", tempK:5830, mag:1.97 },
    "BETELGEUSE": { hygIndex:27918, sourceName:"Betelgeuse", tempK:3794, mag:0.45 },
    "ANTARES": { hygIndex:80517, sourceName:"Antares", tempK:3316, mag:1.06 },
    "RIGEL": { hygIndex:24377, sourceName:"Rigel", tempK:10516, mag:0.18 },
    "DENEB": { hygIndex:101765, sourceName:"Deneb", tempK:9106, mag:1.25 },
};
