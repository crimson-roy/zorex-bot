// lib/majorsState.js
//
// Persistent state for the majors' EMPLOYMENT side.
//
// lib/majors.js = static major catalog
// lib/majorsState.js = live major employment/application state
//
// majors have no users.json entry, so their employees, offers,
// applications, payout state, attendance state, and company wallet
// live here.
//
// This file intentionally keeps state/data logic separate from
// WhatsApp messaging. commands/jobs.js is responsible for sending
// messages to users.

const fs = require("fs");
const dataPath = require("./dataPath");

const { getNextOfferId } = require("./jobOffers");

const {
    MAJORS,
    getMajor,
    getMajorMaxSlots,
    majorPositionRate,
    MAJOR_APPLICATION_DELAY_MS,
    MAJOR_APPLICATION_SUCCESS_RATE,
    MAJOR_ATTENDANCE_WARN_MS,
    MAJOR_ATTENDANCE_FIRE_MS
} = require("./majors");

const MAJORS_FILE = dataPath("majors.json");


// ============================================================
// MAJOR STARTING WALLETS
// ============================================================
//
// These are the initial company balances for the Major companies.
//
// IMPORTANT:
// - These are NOT calculated from level.
// - Major companies are already treated as level 100.
// - These values are only used when a Major does not already
//   have a wallet value in majors.json.
// - Existing wallet balances are NEVER overwritten.
//

const MAJOR_STARTING_WALLETS = {
    "nova empire": 5_000_000_000,
    "elegance": 3_500_000_000,
    "chez adelu": 2_000_000_000
};

const MAJOR_ECONOMY_GROWTH_RATE = 0.70;
const MAJOR_ECONOMY_MULTIPLIER = 1 + MAJOR_ECONOMY_GROWTH_RATE;

function getTotalPersonalEconomy() {

    const USERS_FILE = dataPath("users.json");

    if (!fs.existsSync(USERS_FILE)) {
        return 0;
    }

    let users;

    try {
        users = JSON.parse(
            fs.readFileSync(
                USERS_FILE,
                "utf8"
            )
        );
    } catch (err) {
        console.error(
            "❌ Failed to read users.json for Major economy growth:",
            err.message
        );
        return 0;
    }

    let total = 0;

    for (const user of Object.values(users)) {

        if (!user || typeof user !== "object") {
            continue;
        }

        const wallet =
            Number(user.wallet) || 0;

        const bank =
            Number(user.bank) || 0;

        total += wallet + bank;
    }

    return total;
}


function ensureMajorEconomyGrowth(state) {

    if (!state._economy) {

        const currentEconomy =
            getTotalPersonalEconomy();

        const baseline =
            Math.max(
                currentEconomy,
                1
            );

        state._economy = {
            baseline,
            nextThreshold:
                baseline *
                MAJOR_ECONOMY_MULTIPLIER,
            multiplier:
                MAJOR_ECONOMY_MULTIPLIER,
            totalBoosts: 0
        };

        return true;
    }

    const economy =
        state._economy;

    const currentEconomy =
        getTotalPersonalEconomy();

    if (
        currentEconomy <= 0 ||
        !Number.isFinite(
            economy.nextThreshold
        )
    ) {
        return false;
    }

    let changed = false;

    // A large jump in the economy can cross multiple
    // milestones at once, so process every crossed milestone.
    while (
        currentEconomy >=
        economy.nextThreshold
    ) {

        for (
            const majorKey
            of Object.keys(MAJORS)
        ) {

            const bucket =
                ensureMajorBucket(
                    state,
                    majorKey
                );

            bucket.wallet =
                Math.round(
                    (
                        Number(bucket.wallet) ||
                        0
                    ) *
                    MAJOR_ECONOMY_MULTIPLIER
                );

        }

        economy.totalBoosts =
            (
                economy.totalBoosts ||
                0
            ) + 1;

        economy.nextThreshold *=
            MAJOR_ECONOMY_MULTIPLIER;

        changed = true;
    }

    return changed;
}

// ============================================================
// HELPERS
// ============================================================

function normalizeMajorName(name) {

    return String(name || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

}


function getMajorStartingWallet(majorKey) {

    const major = getMajor(majorKey);

    if (!major) {
        return 0;
    }

    const normalizedName =
        normalizeMajorName(major.name);

    return (
        MAJOR_STARTING_WALLETS[normalizedName] ||
        0
    );

}


// ============================================================
// BASIC STORAGE
// ============================================================

function loadMajorsState() {

    if (!fs.existsSync(MAJORS_FILE)) {

        fs.writeFileSync(
            MAJORS_FILE,
            "{}",
            "utf8"
        );

    }

    const state = JSON.parse(
        fs.readFileSync(
            MAJORS_FILE,
            "utf8"
        )
    );

    let dirty = false;


    // Ensure every configured Major has a bucket.
    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const beforeExists =
            Boolean(state[majorKey]);

        ensureMajorBucket(
            state,
            majorKey
        );

        if (!beforeExists) {

            dirty = true;

        }

    }


    // Check whether the overall personal economy
    // has crossed another +70% growth milestone.
    if (
        ensureMajorEconomyGrowth(state)
    ) {

        dirty = true;

    }


    // Save any newly-created buckets,
    // wallet initialization, or economy growth.
    if (dirty) {

        saveMajorsState(state);

    }


    return state;

}

function saveMajorsState(state) {

    fs.writeFileSync(
        MAJORS_FILE,
        JSON.stringify(
            state,
            null,
            4
        ),
        "utf8"
    );

}


// ============================================================
// MAJOR BUCKET
// ============================================================

function ensureMajorBucket(
    state,
    majorKey
) {

    if (!state[majorKey]) {

        state[majorKey] = {

            lastPayout: Date.now(),

            // Major company wallet.
            //
            // Starting balance:
            // Elegance     -> 5,000,000,000
            // Nova Empire  ->  3,500,000,000
            // Chez Adélu   ->  2,000,000,000
            wallet:
                getMajorStartingWallet(
                    majorKey
                ),

            // Used so an existing wallet is only
            // initialized once.
            walletInitialized: true,

            // positionKey -> stable global offer id
            offerIds: {},

            // employeeId -> employee record
            employees: {},

            // userId -> pending application
            pending: {}

        };

    } else {

        // Migration for Major buckets created before
        // the wallet system existed.
        //
        // IMPORTANT:
        // A real existing wallet of 0 is preserved.
        // We only create a wallet when none exists.

        if (
            typeof state[majorKey].wallet !== "number" ||
            !Number.isFinite(
                state[majorKey].wallet
            )
        ) {

            state[majorKey].wallet =
                getMajorStartingWallet(
                    majorKey
                );

        }

        if (
            state[majorKey].walletInitialized !== true
        ) {

            state[majorKey].walletInitialized = true;

        }

    }

    return state[majorKey];

}


// ============================================================
// STABLE MAJOR OFFER IDS
// ============================================================
//
// Every major position gets an ID from the SAME global counter
// used by player-company offers.
//
// Once assigned, the ID is persisted and reused across restarts
// and repeated .joboffers calls.
//
// Example:
//
// Nova Empire Engineer -> #12
//
// Running .joboffers again still gives:
//
// Nova Empire Engineer -> #12
//
// It does NOT become #13.
//

function getOrAssignOfferId(
    state,
    majorKey,
    positionKey
) {

    const bucket =
        ensureMajorBucket(
            state,
            majorKey
        );

    if (
        !bucket.offerIds[positionKey]
    ) {

        bucket.offerIds[positionKey] =
            getNextOfferId();

    }

    return bucket.offerIds[positionKey];

}


// ============================================================
// LIST ALL OPEN MAJOR OFFERS
// ============================================================
//
// Returns every major position that still has room.
//
// Fully staffed positions are NOT returned.
//
// Each result contains:
//
// {
//     majorKey,
//     major,
//     positionKey,
//     offerId,
//     filledCount,
//     maxSlots
// }
//

function listMajorOpenOffers() {

    const state =
        loadMajorsState();

    const results = [];

    let dirty = false;

    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const major =
            getMajor(majorKey);

        const bucket =
            ensureMajorBucket(
                state,
                majorKey
            );

        for (
            const positionKey
            of Object.keys(
                major.positions
            )
        ) {

            const maxSlots =
                getMajorMaxSlots(
                    majorKey,
                    positionKey
                );

            const filledCount =
                Object.values(
                    bucket.employees
                ).filter(
                    employee =>
                        employee.position ===
                        positionKey
                ).length;

            // Position is fully staffed.
            if (
                filledCount >= maxSlots
            ) {

                continue;

            }

            const offerId =
                getOrAssignOfferId(
                    state,
                    majorKey,
                    positionKey
                );

            dirty = true;

            results.push({

                majorKey,
                major,
                positionKey,
                offerId,
                filledCount,
                maxSlots

            });

        }

    }

    if (dirty) {

        saveMajorsState(state);

    }

    return results.sort(
        (a, b) =>
            a.offerId - b.offerId
    );

}


// ============================================================
// FIND MAJOR OFFER
// ============================================================

function findMajorOfferById(
    offerId
) {

    return (
        listMajorOpenOffers().find(
            offer =>
                offer.offerId === offerId
        ) || null
    );

}


// ============================================================
// FIND MAJOR EMPLOYMENT
// ============================================================
//
// Checks whether a user is currently employed by ANY major.
//
// Player-company employment is handled separately by
// findEmploymentAnywhere() in lib/jobOffers.js.
//

function findMajorEmploymentForUser(
    userId
) {

    const state =
        loadMajorsState();

    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const bucket =
            state[majorKey];

        if (
            !bucket ||
            !bucket.employees
        ) {

            continue;

        }

        for (
            const employeeId
            of Object.keys(
                bucket.employees
            )
        ) {

            const employee =
                bucket.employees[
                    employeeId
                ];

            if (
                employee.userId ===
                userId
            ) {

                return {

                    isMajor: true,

                    majorKey,

                    companyName:
                        getMajor(
                            majorKey
                        ).name,

                    employeeId,

                    position:
                        employee.position

                };

            }

        }

    }

    return null;

}


// ============================================================
// FIND PENDING MAJOR APPLICATION
// ============================================================
//
// Only ONE major application may be pending for a user at a time.
//

function findPendingMajorApplication(
    userId
) {

    const state =
        loadMajorsState();

    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const bucket =
            state[majorKey];

        if (
            bucket &&
            bucket.pending &&
            bucket.pending[userId]
        ) {

            return {

                majorKey,
                ...bucket.pending[userId]

            };

        }

    }

    return null;

}


// ============================================================
// EMPLOYEE CODE GENERATOR
// ============================================================
//
// Major employees receive codes such as:
//
// MAJ-4821
//
// Codes are unique within that major.
//

function generateMajorEmployeeCode(
    bucket
) {

    const existing =
        new Set(
            Object.values(
                bucket.employees
            ).map(
                employee =>
                    employee.code
            )
        );

    let code;

    do {

        code =
            "MAJ-" +
            Math.floor(
                1000 +
                Math.random() *
                9000
            );

    } while (
        existing.has(code)
    );

    return code;

}


// ============================================================
// START MAJOR APPLICATION
// ============================================================
//
// Records the application BEFORE the 30-second timer starts.
//
// This makes the application resumable if the bot restarts.
//

function startMajorApplication(
    majorKey,
    userId,
    positionKey,
    jid
) {

    const state =
        loadMajorsState();

    const bucket =
        ensureMajorBucket(
            state,
            majorKey
        );

    const now =
        Date.now();

    bucket.pending[userId] = {

        position:
            positionKey,

        appliedAt:
            now,

        resolveAt:
            now +
            MAJOR_APPLICATION_DELAY_MS,

        jid

    };

    saveMajorsState(state);

    return bucket.pending[userId];

}


// ============================================================
// RESOLVE MAJOR APPLICATION
// ============================================================
//
// Called after the 30-second application period.
//
// Resolution order:
//
// 1. Make sure application still exists.
// 2. Remove pending application.
// 3. Check whether position filled up.
// 4. If still open, perform 90% roll.
// 5. If successful, create employee.
//
// Does NOT send WhatsApp messages.
//
// commands/jobs.js handles messaging.
//

function resolveMajorApplication(
    majorKey,
    userId
) {

    const state =
        loadMajorsState();

    const bucket =
        ensureMajorBucket(
            state,
            majorKey
        );

    const pending =
        bucket.pending[userId];

    // Already resolved.
    if (!pending) {

        return null;

    }

    delete bucket.pending[userId];

    const major =
        getMajor(
            majorKey
        );

    const positionKey =
        pending.position;

    const maxSlots =
        getMajorMaxSlots(
            majorKey,
            positionKey
        );

    const filledCount =
        Object.values(
            bucket.employees
        ).filter(
            employee =>
                employee.position ===
                positionKey
        ).length;


    // --------------------------------------------------------
    // POSITION FILLED WHILE APPLICATION WAS PENDING
    // --------------------------------------------------------

    if (
        filledCount >= maxSlots
    ) {

        saveMajorsState(
            state
        );

        return {

            accepted: false,

            reason: "filled",

            majorKey,

            major,

            positionKey,

            jid:
                pending.jid

        };

    }


    // --------------------------------------------------------
    // APPLICATION SUCCESS ROLL
    // --------------------------------------------------------

    const won =
        Math.random() <
        MAJOR_APPLICATION_SUCCESS_RATE;

    if (!won) {

        saveMajorsState(
            state
        );

        return {

            accepted: false,

            reason: "roll",

            majorKey,

            major,

            positionKey,

            jid:
                pending.jid

        };

    }


    // --------------------------------------------------------
    // CREATE EMPLOYEE
    // --------------------------------------------------------

    bucket.employeeSeq =
        (bucket.employeeSeq || 0) +
        1;

    const employeeId =
        `majemp_${Date.now()}_${Math.floor(Math.random() * 1000)}_${bucket.employeeSeq}`;

    const code =
        generateMajorEmployeeCode(
            bucket
        );

    const rate =
        majorPositionRate(
            majorKey,
            positionKey
        );

    bucket.employees[
        employeeId
    ] = {

        num:
            bucket.employeeSeq,

        code,

        userId,

        position:
            positionKey,

        salaryRate:
            rate,

        hiredAt:
            Date.now(),

        dutyLog: []

    };

    saveMajorsState(
        state
    );

    return {

        accepted: true,

        majorKey,

        major,

        positionKey,

        employeeId,

        code,

        jid:
            pending.jid

    };

}


// ============================================================
// MAJOR PAYOUT COLLECTION
// ============================================================
//
// Same settlement model as player-company collectPendingIncome():
//
// - calculate every complete payout period
// - each employee must have been on duty during that period
// - salary goes directly into employee's wallet
//
// IMPORTANT:
//
// This function saves majors.json itself.
//
// It does NOT save users.json.
//
// The caller MUST call:
//
// saveUsers(users);
//
// afterward.
//

function collectPendingMajorIncome(
    users,
    majorKey,
    PAYOUT_INTERVAL_MS,
    wasOnDutyDuring
) {

    const state =
        loadMajorsState();

    const bucket =
        ensureMajorBucket(
            state,
            majorKey
        );

    const major =
        getMajor(
            majorKey
        );

    const now =
        Date.now();

    const elapsed =
        now -
        bucket.lastPayout;

    const periods =
        Math.floor(
            elapsed /
            PAYOUT_INTERVAL_MS
        );

    if (
        periods <= 0
    ) {

        return null;

    }

    const incomePerPeriod =
        major.income;

    const periodStartBase =
        bucket.lastPayout;

    const employeePayouts = {};

    // --------------------------------------------------------
    // PROCESS EVERY COMPLETE PERIOD
    // --------------------------------------------------------

    for (
        let i = 0;
        i < periods;
        i++
    ) {

        const periodStart =
            periodStartBase +
            i *
            PAYOUT_INTERVAL_MS;

        const periodEnd =
            periodStart +
            PAYOUT_INTERVAL_MS;

        for (
            const employeeId
            of Object.keys(
                bucket.employees
            )
        ) {

            const employee =
                bucket.employees[
                    employeeId
                ];

            const rate =
                employee.salaryRate ||
                0;

            if (
                rate <= 0
            ) {

                continue;

            }

            // Employees who have submitted a resignation
            // forfeit the pending payout.
            if (
                users[employee.userId]?.jobResignation
            ) {

                continue;

            }

            if (
                !wasOnDutyDuring(
                    employee,
                    periodStart,
                    periodEnd
                )
            ) {

                continue;

            }

            const amount =
                Math.round(
                    incomePerPeriod *
                    (rate / 100)
                );

            employeePayouts[
                employee.userId
            ] =
                (
                    employeePayouts[
                        employee.userId
                    ] ||
                    0
                ) +
                amount;

        }

    }

    // Move payout clock forward.
    bucket.lastPayout +=
        periods *
        PAYOUT_INTERVAL_MS;

    // --------------------------------------------------------
    // PAY EMPLOYEES
    // --------------------------------------------------------

    for (
        const empUserId
        of Object.keys(
            employeePayouts
        )
    ) {

        if (
            !users[empUserId]
        ) {

            continue;

        }

        users[empUserId].wallet =
            (
                users[empUserId].wallet ||
                0
            ) +
            employeePayouts[
                empUserId
            ];

    }

    saveMajorsState(
        state
    );

    return {

        employeePayouts

    };

}
    // --------------------------------------------------------
    // PROCESS EVERY COMPLETE PERIOD
    // --------------------------------------------------------

    for (
        let i = 0;
        i < periods;
        i++
    ) {

        const periodStart =
            periodStartBase +
            i *
            PAYOUT_INTERVAL_MS;

        const periodEnd =
            periodStart +
            PAYOUT_INTERVAL_MS;


        for (
            const employeeId
            of Object.keys(
                bucket.employees
            )
        ) {

            const employee =
                bucket.employees[
                    employeeId
                ];

            const rate =
                employee.salaryRate ||
                0;

            if (
                rate <= 0
            ) {

                continue;

            }

            if (
                !wasOnDutyDuring(
                    employee,
                    periodStart,
                    periodEnd
                )
            ) {

                continue;

            }

            const amount =
                Math.round(
                    incomePerPeriod *
                    (rate / 100)
                );

            employeePayouts[
                employee.userId
            ] =
                (
                    employeePayouts[
                        employee.userId
                    ] || 0
                ) +
                amount;

        }

    }


    // Move payout clock forward.
    bucket.lastPayout +=
        periods *
        PAYOUT_INTERVAL_MS;


    // --------------------------------------------------------
    // PAY EMPLOYEES
    // --------------------------------------------------------

    for (
        const empUserId
        of Object.keys(
            employeePayouts
        )
    ) {

        if (
            !users[empUserId]
        ) {

            continue;

        }

        users[empUserId].wallet =
            (
                users[empUserId].wallet ||
                0
            ) +
            employeePayouts[
                empUserId
            ];

    }


    saveMajorsState(
        state
    );

    return {

        employeePayouts

    };


// ============================================================
// LIST ALL PENDING APPLICATIONS
// ============================================================
//
// Used during startup to restore applications that were in-flight
// when the bot process stopped.
//

function listAllPendingApplications() {

    const state =
        loadMajorsState();

    const all = [];

    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const bucket =
            state[majorKey];

        if (
            !bucket ||
            !bucket.pending
        ) {

            continue;

        }

        for (
            const userId
            of Object.keys(
                bucket.pending
            )
        ) {

            all.push({

                majorKey,

                userId,

                ...bucket.pending[
                    userId
                ]

            });

        }

    }

    return all;

}


// ============================================================
// ATTENDANCE
// ============================================================
//
// Major attendance is separate from the application system.
//
// Last activity =
//     most recent .duty timestamp
// OR
//     hiredAt if they have never checked in.
//
// The actual warning/firing thresholds come from lib/majors.js.
//

function getLastMajorActivity(
    employee
) {

    const log =
        employee.dutyLog ||
        [];

    return log.length
        ? log[log.length - 1]
        : employee.hiredAt;

}


// ============================================================
// REMOVE MAJOR EMPLOYEE
// ============================================================
//
// Removes the employee from the major.
//
// Returns the removed employee record so jobs.js can use it
// when composing the firing message.
//

function removeMajorEmployee(
    majorKey,
    employeeId
) {

    const state =
        loadMajorsState();

    const bucket =
        state[majorKey];

    if (
        !bucket ||
        !bucket.employees ||
        !bucket.employees[employeeId]
    ) {

        return null;

    }

    const employee =
        bucket.employees[
            employeeId
        ];

    delete bucket.employees[
        employeeId
    ];

    saveMajorsState(
        state
    );

    return employee;

}


// ============================================================
// SCAN MAJOR ATTENDANCE
// ============================================================
//
// Pure scan.
//
// Does NOT send messages.
//
// Does NOT remove employees.
//
// It only returns actions for commands/jobs.js to perform.
//
// Possible results:
//
// {
//     type: "warn",
//     majorKey,
//     employeeId,
//     userId,
//     position
// }
//
// OR:
//
// {
//     type: "fire",
//     majorKey,
//     employeeId,
//     userId,
//     position
// }
//

function scanMajorAttendance() {

    const state =
        loadMajorsState();

    const now =
        Date.now();

    const actions = [];


    for (
        const majorKey
        of Object.keys(MAJORS)
    ) {

        const bucket =
            state[majorKey];

        if (
            !bucket ||
            !bucket.employees
        ) {

            continue;

        }


        for (
            const employeeId
            of Object.keys(
                bucket.employees
            )
        ) {

            const employee =
                bucket.employees[
                    employeeId
                ];

            const lastActivity =
                getLastMajorActivity(
                    employee
                );

            const idle =
                now -
                lastActivity;


            // ------------------------------------------------
            // 3 DAYS -> FIRE
            // ------------------------------------------------

            if (
                idle >=
                MAJOR_ATTENDANCE_FIRE_MS
            ) {

                actions.push({

                    type: "fire",

                    majorKey,

                    employeeId,

                    userId:
                        employee.userId,

                    position:
                        employee.position

                });

                continue;

            }


            // ------------------------------------------------
            // 2 DAYS -> WARNING
            // ------------------------------------------------

            if (
                idle >=
                MAJOR_ATTENDANCE_WARN_MS
            ) {

                const alreadyWarnedThisStreak =
                    employee.attendanceWarnedAt &&
                    employee.attendanceWarnedAt >=
                    lastActivity;

                if (
                    !alreadyWarnedThisStreak
                ) {

                    actions.push({

                        type: "warn",

                        majorKey,

                        employeeId,

                        userId:
                            employee.userId,

                        position:
                            employee.position

                    });

                }

            }

        }

    }

    return actions;

}


// ============================================================
// MARK ATTENDANCE WARNING
// ============================================================
//
// Records when the employee received their warning.
//
// This prevents the monitor from repeatedly DMing the employee
// every 30 minutes during the same idle streak.
//
// Once the employee uses .duty again, their lastActivity becomes
// newer than attendanceWarnedAt, naturally allowing the next
// idle streak to trigger another warning.
//

function markAttendanceWarned(
    majorKey,
    employeeId,
    when
) {

    const state =
        loadMajorsState();

    const bucket =
        state[majorKey];

    if (
        !bucket ||
        !bucket.employees ||
        !bucket.employees[employeeId]
    ) {

        return;

    }

    bucket.employees[
        employeeId
    ].attendanceWarnedAt =
        when;

    saveMajorsState(
        state
    );

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    // Storage
    loadMajorsState,
    saveMajorsState,

    // Major buckets / offers
    ensureMajorBucket,
    getOrAssignOfferId,
    listMajorOpenOffers,
    findMajorOfferById,

    // Employment
    findMajorEmploymentForUser,

    // Applications
    findPendingMajorApplication,
    startMajorApplication,
    resolveMajorApplication,
    listAllPendingApplications,

    // Payouts
    collectPendingMajorIncome,

    // Attendance
    getLastMajorActivity,
    removeMajorEmployee,
    scanMajorAttendance,
    markAttendanceWarned,

    // Major wallet configuration
    MAJOR_STARTING_WALLETS

};