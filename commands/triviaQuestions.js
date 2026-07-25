// Zorex trivia question bank.
//
// To add more questions, just push more objects into the array below —
// nothing else in the codebase needs to change. Each entry:
//
//   {
//       category: "Science",                        // one of CATEGORY_ALIASES keys (or add a new one there too)
//       question: "Which planet is known as the Red Planet?",
//       options: ["Earth", "Mars", "Venus", "Jupiter"],  // exactly 4, in A/B/C/D order
//       answer: "B"                                  // "A" | "B" | "C" | "D"
//   }
//
// Categories are matched case-insensitively against CATEGORY_ALIASES below,
// so ".trivia general knowledge", ".trivia general", and ".trivia gk" can
// all resolve to the same bucket if you wire up the aliases that way.

const QUESTIONS = [

    // ---------- General Knowledge ----------
    {
        category: "General Knowledge",
        question: "How many continents are there on Earth?",
        options: ["5", "6", "7", "8"],
        answer: "C"
    },
    {
        category: "General Knowledge",
        question: "What is the largest organ in the human body?",
        options: ["Heart", "Liver", "Skin", "Lungs"],
        answer: "C"
    },
    {
        category: "General Knowledge",
        question: "How many days are there in a leap year?",
        options: ["364", "365", "366", "367"],
        answer: "C"
    },

    // ---------- Science ----------
    {
        category: "Science",
        question: "Which planet is known as the Red Planet?",
        options: ["Earth", "Mars", "Venus", "Jupiter"],
        answer: "B"
    },
    {
        category: "Science",
        question: "What gas do plants absorb from the atmosphere for photosynthesis?",
        options: ["Oxygen", "Nitrogen", "Carbon Dioxide", "Hydrogen"],
        answer: "C"
    },
    {
        category: "Science",
        question: "What is the chemical symbol for gold?",
        options: ["Gd", "Go", "Au", "Ag"],
        answer: "C"
    },

    // ---------- Technology ----------
    {
        category: "Technology",
        question: "What does 'CPU' stand for?",
        options: [
            "Central Processing Unit",
            "Computer Personal Unit",
            "Central Program Utility",
            "Core Processing Unit"
        ],
        answer: "A"
    },
    {
        category: "Technology",
        question: "Which company created the JavaScript engine V8?",
        options: ["Microsoft", "Mozilla", "Google", "Apple"],
        answer: "C"
    },
    {
        category: "Technology",
        question: "What does 'HTTP' stand for?",
        options: [
            "HyperText Transfer Protocol",
            "High Transfer Text Protocol",
            "HyperText Terminal Process",
            "Home Tool Transfer Protocol"
        ],
        answer: "A"
    },

    // ---------- Geography ----------
    {
        category: "Geography",
        question: "What is the longest river in the world?",
        options: ["Amazon", "Nile", "Yangtze", "Mississippi"],
        answer: "B"
    },
    {
        category: "Geography",
        question: "Which country has the largest population in Africa?",
        options: ["Egypt", "Ethiopia", "Nigeria", "South Africa"],
        answer: "C"
    },
    {
        category: "Geography",
        question: "What is the capital city of Japan?",
        options: ["Seoul", "Beijing", "Tokyo", "Bangkok"],
        answer: "C"
    },

    // ---------- History ----------
    {
        category: "History",
        question: "In what year did World War II end?",
        options: ["1943", "1944", "1945", "1946"],
        answer: "C"
    },
    {
        category: "History",
        question: "Who was the first President of the United States?",
        options: ["Thomas Jefferson", "George Washington", "John Adams", "Abraham Lincoln"],
        answer: "B"
    },
    {
        category: "History",
        question: "Nigeria gained independence from Britain in which year?",
        options: ["1957", "1960", "1963", "1966"],
        answer: "B"
    },

    // ---------- Bible ----------
    {
        category: "Bible",
        question: "Who built the ark according to the Bible?",
        options: ["Abraham", "Moses", "Noah", "David"],
        answer: "C"
    },
    {
        category: "Bible",
        question: "How many books are there in the New Testament?",
        options: ["24", "27", "30", "39"],
        answer: "B"
    },
    {
        category: "Bible",
        question: "Who was thrown into the lions' den?",
        options: ["Daniel", "Elijah", "Jonah", "Samuel"],
        answer: "A"
    },

    // ---------- Gospel ----------
    {
        category: "Gospel",
        question: "How many gospels are in the New Testament?",
        options: ["2", "3", "4", "5"],
        answer: "C"
    },
    {
        category: "Gospel",
        question: "In which town was Jesus born, according to the Gospels?",
        options: ["Nazareth", "Jerusalem", "Bethlehem", "Capernaum"],
        answer: "C"
    },
    {
        category: "Gospel",
        question: "Who baptized Jesus in the Jordan River?",
        options: ["Peter", "John the Baptist", "Andrew", "Philip"],
        answer: "B"
    },

    // ---------- Social Studies ----------
    {
        category: "Social Studies",
        question: "What term describes a government run by the people?",
        options: ["Monarchy", "Democracy", "Autocracy", "Oligarchy"],
        answer: "B"
    },
    {
        category: "Social Studies",
        question: "What is the study of human societies and their development called?",
        options: ["Biology", "Sociology", "Geology", "Astronomy"],
        answer: "B"
    },

    // ---------- Sports ----------
    {
        category: "Sports",
        question: "How many players are on a standard football (soccer) team on the pitch?",
        options: ["9", "10", "11", "12"],
        answer: "C"
    },
    {
        category: "Sports",
        question: "In which sport would you perform a slam dunk?",
        options: ["Volleyball", "Basketball", "Tennis", "Badminton"],
        answer: "B"
    },
    {
        category: "Sports",
        question: "How often are the Summer Olympic Games held?",
        options: ["Every 2 years", "Every 3 years", "Every 4 years", "Every 5 years"],
        answer: "C"
    }

];

// Maps whatever a user types after ".trivia" to a canonical category name
// used in the QUESTIONS array above. Add new keys here as you add new
// categories — the trivia command itself never needs to change.
const CATEGORY_ALIASES = {
    "general": "General Knowledge",
    "general knowledge": "General Knowledge",
    "gk": "General Knowledge",

    "science": "Science",
    "sci": "Science",

    "tech": "Technology",
    "technology": "Technology",

    "geo": "Geography",
    "geography": "Geography",

    "history": "History",

    "bible": "Bible",

    "gospel": "Gospel",

    "social": "Social Studies",
    "social studies": "Social Studies",

    "sports": "Sports",
    "sport": "Sports"
};

module.exports = {
    QUESTIONS,
    CATEGORY_ALIASES
};
