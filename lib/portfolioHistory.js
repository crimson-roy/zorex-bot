const fs = require("fs");
const dataPath = require("./dataPath");

const PORTFOLIO_FILE = dataPath("portfolioHistory.json");

// ============================================================
// STORAGE
// ============================================================

function loadPortfolioHistory() {

    if (!fs.existsSync(PORTFOLIO_FILE)) {
        fs.writeFileSync(
            PORTFOLIO_FILE,
            "{}",
            "utf8"
        );
    }

    return JSON.parse(
        fs.readFileSync(
            PORTFOLIO_FILE,
            "utf8"
        )
    );

}

function savePortfolioHistory(history) {

    fs.writeFileSync(
        PORTFOLIO_FILE,
        JSON.stringify(history, null, 4),
        "utf8"
    );

}


// ============================================================
// USER HISTORY
// ============================================================

function ensureUserHistory(history, userId) {

    if (!history[userId]) {

        history[userId] = {
            jobs: []
        };

    }

    if (!Array.isArray(history[userId].jobs)) {
        history[userId].jobs = [];
    }

    return history[userId];

}


// ============================================================
// START EMPLOYMENT
// ============================================================
//
// Creates a permanent career-history entry.
//
// current:
//   true until the employee leaves/fired
//
// hiredAt:
//   real timestamp
//
// endedAt:
//   null while currently employed
//
// tier:
//   snapshot of company tier when employment started
//
// The tier is stored here deliberately so an old job keeps the
// company's tier from that employment period rather than changing
// later when the company upgrades.
//
// ============================================================

function startEmployment({
    userId,
    companyName,
    position,
    tier = null,
    hiredAt = Date.now(),
    companyType = "player"
}) {

    if (!userId || !companyName || !position) {
        return null;
    }

    const history = loadPortfolioHistory();

    const userHistory =
        ensureUserHistory(history, userId);

    // Prevent duplicate active records for the same company/position.
    const existing =
        userHistory.jobs.find(job =>
            !job.endedAt &&
            job.companyName === companyName &&
            job.position === position
        );

    if (existing) {

        let changed = false;

        // Reconcile older live employment records that predate the
        // portfolio feature. If the authoritative roster says the user
        // was hired earlier than the portfolio entry, preserve that
        // original hire date instead of counting experience only from
        // the day portfolio tracking was introduced.
        if (
            Number.isFinite(hiredAt) &&
            (
                !Number.isFinite(
                    existing.hiredAt
                ) ||
                hiredAt <
                existing.hiredAt
            )
        ) {
            existing.hiredAt =
                hiredAt;

            changed = true;
        }

        if (
            existing.tier == null &&
            tier != null
        ) {
            existing.tier =
                tier;

            changed = true;
        }

        if (
            !existing.companyType &&
            companyType
        ) {
            existing.companyType =
                companyType;

            changed = true;
        }

        if (changed) {
            savePortfolioHistory(
                history
            );
        }

        return existing;
    }

    const entry = {

        companyName,
        position,
        tier,

        companyType,

        hiredAt,

        endedAt: null

    };

    userHistory.jobs.push(entry);

    savePortfolioHistory(history);

    return entry;

}


// ============================================================
// END EMPLOYMENT
// ============================================================
//
// Marks the active matching employment record as completed.
//
// We match by company + employee position. If there are multiple
// active records, the newest one is closed.
//
// ============================================================

function endEmployment({
    userId,
    companyName,
    position,
    endedAt = Date.now()
}) {

    if (!userId || !companyName || !position) {
        return null;
    }

    const history = loadPortfolioHistory();

    const userHistory =
        ensureUserHistory(history, userId);

    const matches =
        userHistory.jobs
            .filter(job =>
                !job.endedAt &&
                job.companyName === companyName &&
                job.position === position
            )
            .sort(
                (a, b) =>
                    b.hiredAt - a.hiredAt
            );

    const entry = matches[0];

    if (!entry) {
        return null;
    }

    entry.endedAt = endedAt;

    savePortfolioHistory(history);

    return entry;

}


// ============================================================
// UPDATE POSITION
// ============================================================
//
// Used when an employee is promoted.
//
// The old position is closed and a new history record begins at
// the promotion time.
//
// This preserves the user's actual career progression:
//
// Engineer -> Supervisor -> Manager
//
// Each position gets its own experience period.
//
// ============================================================

function updatePosition({
    userId,
    companyName,
    oldPosition,
    newPosition,
    tier = null,
    changedAt = Date.now(),
    companyType = "player"
}) {

    if (
        !userId ||
        !companyName ||
        !oldPosition ||
        !newPosition
    ) {
        return null;
    }

    if (oldPosition === newPosition) {
        return null;
    }

    const history = loadPortfolioHistory();

    const userHistory =
        ensureUserHistory(history, userId);

    const activeOldJob =
        userHistory.jobs
            .filter(job =>
                !job.endedAt &&
                job.companyName === companyName &&
                job.position === oldPosition
            )
            .sort(
                (a, b) =>
                    b.hiredAt - a.hiredAt
            )[0];

    if (activeOldJob) {
        activeOldJob.endedAt = changedAt;
    }

    const newEntry = {

        companyName,
        position: newPosition,
        tier,

        companyType,

        hiredAt: changedAt,

        endedAt: null

    };

    userHistory.jobs.push(newEntry);

    savePortfolioHistory(history);

    return newEntry;

}


// ============================================================
// GET USER HISTORY
// ============================================================

function getUserHistory(userId) {

    if (!userId) {
        return [];
    }

    const history = loadPortfolioHistory();

    return (
        history[userId]?.jobs || []
    );

}


// ============================================================
// GET CURRENT JOB
// ============================================================

function getCurrentEmployment(userId) {

    const jobs =
        getUserHistory(userId);

    return (
        jobs.find(job => !job.endedAt) ||
        null
    );

}


// ============================================================
// EXPERIENCE CALCULATION
// ============================================================
//
// Portfolio rule:
//
// 1 REAL DAY = 1 PORTFOLIO MONTH
//
// Example:
//
// 24 hours worked  -> 1 month
// 48 hours worked  -> 2 months
// 14 days worked   -> 14 months
//
// Completed jobs use:
//   endedAt - hiredAt
//
// Current jobs use:
//   Date.now() - hiredAt
//
// Partial days are not counted as a full month.
//
// ============================================================

const PORTFOLIO_MONTH_MS =
    24 * 60 * 60 * 1000;

function experienceMonthsBetween(start, end) {

    if (!start || !end) {
        return 0;
    }

    const elapsed =
        Math.max(0, end - start);

    return Math.floor(
        elapsed / PORTFOLIO_MONTH_MS
    );

}

function getJobExperienceMonths(job) {

    if (!job || !job.hiredAt) {
        return 0;
    }

    const end =
        job.endedAt || Date.now();

    return experienceMonthsBetween(
        job.hiredAt,
        end
    );

}

function getTotalExperienceMonths(userId) {

    const jobs =
        getUserHistory(userId);

    return jobs.reduce(
        (total, job) =>
            total +
            getJobExperienceMonths(job),
        0
    );

}


// ============================================================
// FORMAT EXPERIENCE
// ============================================================

function formatExperience(months) {

    const value =
        Math.max(0, Math.floor(months));

    if (value === 1) {
        return "1 month";
    }

    return `${value} months`;

}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    loadPortfolioHistory,
    savePortfolioHistory,

    startEmployment,
    endEmployment,
    updatePosition,

    getUserHistory,
    getCurrentEmployment,

    experienceMonthsBetween,
    getJobExperienceMonths,
    getTotalExperienceMonths,

    formatExperience

};