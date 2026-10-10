// Question bank required by commands/trivia.js.
// Keep each answer as the matching option letter: A, B, C, or D.

const QUESTIONS = [
    { category: "Science", question: "Which planet is known as the Red Planet?", options: ["Venus", "Mars", "Jupiter", "Mercury"], answer: "B" },
    { category: "Science", question: "What is the chemical symbol for gold?", options: ["Ag", "Gd", "Au", "Go"], answer: "C" },
    { category: "Science", question: "Which gas do plants absorb from the atmosphere for photosynthesis?", options: ["Oxygen", "Nitrogen", "Carbon dioxide", "Hydrogen"], answer: "C" },
    { category: "Science", question: "What is the center of an atom called?", options: ["Electron", "Nucleus", "Cell", "Molecule"], answer: "B" },
    { category: "Science", question: "How many bones are typically in an adult human body?", options: ["106", "206", "306", "406"], answer: "B" },
    { category: "Geography", question: "What is the largest ocean on Earth?", options: ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean", "Pacific Ocean"], answer: "D" },
    { category: "Geography", question: "What is the capital of Japan?", options: ["Kyoto", "Seoul", "Tokyo", "Osaka"], answer: "C" },
    { category: "Geography", question: "Which continent is the Sahara Desert in?", options: ["Asia", "Africa", "Australia", "South America"], answer: "B" },
    { category: "Geography", question: "What is the capital of Nigeria?", options: ["Lagos", "Kano", "Abuja", "Ibadan"], answer: "C" },
    { category: "Geography", question: "Which river flows through Egypt?", options: ["Amazon", "Nile", "Danube", "Yangtze"], answer: "B" },
    { category: "History", question: "In which year did World War II end?", options: ["1939", "1942", "1945", "1950"], answer: "C" },
    { category: "History", question: "Who was the first president of the United States?", options: ["Abraham Lincoln", "George Washington", "John Adams", "Thomas Jefferson"], answer: "B" },
    { category: "History", question: "The ancient pyramids of Giza are in which country?", options: ["Mexico", "Greece", "Egypt", "India"], answer: "C" },
    { category: "Sports", question: "How many players from one football team are on the pitch at the start of a standard match?", options: ["9", "10", "11", "12"], answer: "C" },
    { category: "Sports", question: "Which sport is played at Wimbledon?", options: ["Cricket", "Tennis", "Golf", "Rugby"], answer: "B" },
    { category: "Sports", question: "How often are the Summer Olympic Games normally held?", options: ["Every 2 years", "Every 3 years", "Every 4 years", "Every 5 years"], answer: "C" },
    { category: "Technology", question: "What does CPU stand for?", options: ["Central Processing Unit", "Computer Power Utility", "Core Program Upload", "Central Program User"], answer: "A" },
    { category: "Technology", question: "Which language is primarily used to style web pages?", options: ["HTML", "CSS", "SQL", "Python"], answer: "B" },
    { category: "Technology", question: "What does URL stand for?", options: ["Universal Reading Link", "Uniform Resource Locator", "United Routing Language", "User Reference List"], answer: "B" },
    { category: "Technology", question: "Which company develops the Android operating system?", options: ["Apple", "Microsoft", "Google", "Nintendo"], answer: "C" },
    { category: "Entertainment", question: "Which fictional detective lives at 221B Baker Street?", options: ["Hercule Poirot", "Sherlock Holmes", "Nancy Drew", "Columbo"], answer: "B" },
    { category: "Entertainment", question: "Which instrument has keys, pedals, and strings?", options: ["Flute", "Piano", "Trumpet", "Drum"], answer: "B" },
    { category: "Mathematics", question: "What is 12 × 12?", options: ["124", "132", "144", "154"], answer: "C" },
    { category: "Mathematics", question: "What is the square root of 81?", options: ["7", "8", "9", "10"], answer: "C" },
    { category: "Mathematics", question: "How many degrees are in a right angle?", options: ["45", "90", "180", "360"], answer: "B" }
];

const CATEGORY_ALIASES = {
    science: "Science",
    sciences: "Science",
    geography: "Geography",
    geo: "Geography",
    history: "History",
    sports: "Sports",
    sport: "Sports",
    football: "Sports",
    technology: "Technology",
    tech: "Technology",
    computers: "Technology",
    entertainment: "Entertainment",
    music: "Entertainment",
    maths: "Mathematics",
    math: "Mathematics",
    mathematics: "Mathematics"
};

module.exports = { QUESTIONS, CATEGORY_ALIASES };
