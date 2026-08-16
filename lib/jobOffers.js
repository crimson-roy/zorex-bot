// lib/jobOffers.js
//
// Offer IDs are global and permanent — assigned once from a single
// counter, never reused. That's what lets .joboffers freely show/hide
// offers as they open and fill without renumbering anything, while
// .jobapply <id> always points at one unambiguous target regardless of
// how many other offers have opened or closed since.

const fs = require("fs");
const dataPath = require("./dataPath");

const COUNTER_FILE = dataPath("offerCounter.json");

function loadCounter() {

    if (!fs.existsSync(COUNTER_FILE)) fs.writeFileSync(COUNTER_FILE, JSON.stringify({ next: 1 }));

    return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));

}

function saveCounter(counter) {

    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter, null, 4), "utf8");

}

function getNextOfferId() {

    const counter = loadCounter();
    const id = counter.next;

    counter.next += 1;
    saveCounter(counter);

    return id;

}

// Scans every user's company for an open offer with this ID.
// Returns { ownerId, company, positionKey, offer } or null.
function findOfferById(users, offerId) {

    for (const ownerId of Object.keys(users)) {

        const company = users[ownerId].company;
        if (!company || !company.offers) continue;

        for (const positionKey of Object.keys(company.offers)) {

            const offer = company.offers[positionKey];

            if (offer.id === offerId) {
                return { ownerId, company, positionKey, offer };
            }

        }

    }

    return null;

}

// Every open offer across every player company, for .joboffers.
//
// Majors (Nova Empire, Elegance, Chez Adélu) are NOT included here yet —
// their income model is still an open question in the spec (they have
// no `level` to run incomeAtLevel() against, so there's no live 🌙
// amount to show). Once that's resolved, merge a second array built to
// this same { ownerId, companyName, industry, level, positionKey, offer }
// shape into the results below.
function listOpenOffers(users) {

    const results = [];

    for (const ownerId of Object.keys(users)) {

        const company = users[ownerId].company;
        if (!company || !company.offers) continue;

        for (const positionKey of Object.keys(company.offers)) {

            results.push({
                ownerId,
                company, // full reference — lets callers compute filled/max slots via lib/industries.js without this file needing to import it
                companyName: company.name,
                industry: company.industry,
                level: company.level,
                positionKey,
                offer: company.offers[positionKey]
            });

        }

    }

    return results.sort((a, b) => a.offer.id - b.offer.id);

}

// Is this user already employed at ANY company (their own or someone
// else's)? Used by .jobapply to enforce one active job per person.
// NOT explicitly stated in the spec — this is an assumed default, easy
// to remove here if multiple simultaneous jobs should actually be allowed.
function findEmploymentAnywhere(users, userId) {

    for (const ownerId of Object.keys(users)) {

        const company = users[ownerId].company;
        if (!company || !company.employees) continue;

        for (const employeeId of Object.keys(company.employees)) {

            if (company.employees[employeeId].userId === userId) {
                return {
                    ownerId,
                    companyName: company.name,
                    employeeId,
                    position: company.employees[employeeId].position
                };
            }

        }

    }

    return null;

}

module.exports = {
    getNextOfferId,
    findOfferById,
    listOpenOffers,
    findEmploymentAnywhere
};
