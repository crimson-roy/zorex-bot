"use strict";

const MAX_PROMPT_LENGTH = 160;
const MAX_TOKENS = 80;
const MAX_ABS_RESULT = 1e15;
const MAX_ABS_EXPONENT = 100;

class LocalMathError extends Error {}

function extractArithmeticExpression(prompt) {
    const original = String(prompt || "").trim();

    if (!original || original.length > MAX_PROMPT_LENGTH) {
        return null;
    }

    let expression = original;

    const prefix = /^(?:(?:please|can you|could you)\\s+)?(?:calculate|compute|evaluate|work\\s+out|what\\s+is|what's|whats|how\\s+much\\s+is)\\s+/i;
    expression = expression.replace(prefix, "");

    expression = expression
        .replace(/\\bto\\s+the\\s+power\\s+of\\b/gi, "^")
        .replace(/\\bmultiplied\\s+by\\b/gi, "*")
        .replace(/\\bdivided\\s+by\\b/gi, "/")
        .replace(/\\bplus\\b/gi, "+")
        .replace(/\\bminus\\b/gi, "-")
        .replace(/\\btimes\\b/gi, "*")
        .replace(/\\bof\\b/gi, "*")
        .replace(/[?.!]+$/g, "")
        .trim();

    if (!expression || !/[+\\-*/^%]/.test(expression)) {
        return null;
    }

    if (!/^[0-9\\s.+\\-*/^()%]+$/.test(expression)) {
        return null;
    }

    return expression;
}

function tokenize(expression) {
    const tokens = [];
    let index = 0;

    while (index < expression.length) {
        const char = expression[index];

        if (/\\s/.test(char)) {
            index += 1;
            continue;
        }

        if (/[0-9.]/.test(char)) {
            const start = index;
            let sawDigit = false;
            let sawDecimal = false;

            while (index < expression.length) {
                const current = expression[index];

                if (/[0-9]/.test(current)) {
                    sawDigit = true;
                    index += 1;
                    continue;
                }

                if (current === "." && !sawDecimal) {
                    sawDecimal = true;
                    index += 1;
                    continue;
                }

                break;
            }

            const raw = expression.slice(start, index);
            if (!sawDigit) {
                throw new SyntaxError("Invalid number");
            }

            const value = Number(raw);
            if (!Number.isFinite(value)) {
                throw new SyntaxError("Invalid number");
            }

            tokens.push({ type: "number", value });
        } else if ("()+-*/^%".includes(char)) {
            tokens.push({ type: char, value: char });
            index += 1;
        } else {
            throw new SyntaxError("Unsupported character");
        }

        if (tokens.length > MAX_TOKENS) {
            throw new SyntaxError("Too many tokens");
        }
    }

    return tokens;
}

function guardResult(value) {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_RESULT) {
        throw new LocalMathError("That calculation is outside the supported numeric range.");
    }
    return value;
}

function parseTokens(tokens) {
    let index = 0;

    function peek(type) {
        return tokens[index]?.type === type;
    }

    function consume(type) {
        if (!peek(type)) return false;
        index += 1;
        return true;
    }

    function parsePrimary() {
        const token = tokens[index];

        if (token?.type === "number") {
            index += 1;
            return token.value;
        }

        if (consume("(")) {
            const value = parseAdditive();
            if (!consume(")")) {
                throw new SyntaxError("Missing closing parenthesis");
            }
            return value;
        }

        throw new SyntaxError("Expected a number or parenthesised expression");
    }

    function parsePostfix() {
        let value = parsePrimary();
        while (consume("%")) {
            value = guardResult(value / 100);
        }
        return value;
    }

    function parsePower() {
        const base = parsePostfix();
        if (!consume("^")) return base;

        const exponent = parseUnary();
        if (Math.abs(exponent) > MAX_ABS_EXPONENT) {
            throw new LocalMathError("That exponent is too large to calculate safely.");
        }
        return guardResult(Math.pow(base, exponent));
    }

    function parseUnary() {
        if (consume("+")) return parseUnary();
        if (consume("-")) return guardResult(-parseUnary());
        return parsePower();
    }

    function parseMultiplicative() {
        let value = parseUnary();

        while (peek("*") || peek("/")) {
            const operator = tokens[index].type;
            index += 1;
            const right = parseUnary();

            if (operator === "/" && right === 0) {
                throw new LocalMathError("Cannot divide by zero.");
            }

            value = guardResult(operator === "*" ? value * right : value / right);
        }

        return value;
    }

    function parseAdditive() {
        let value = parseMultiplicative();

        while (peek("+") || peek("-")) {
            const operator = tokens[index].type;
            index += 1;
            const right = parseMultiplicative();
            value = guardResult(operator === "+" ? value + right : value - right);
        }

        return value;
    }

    const result = parseAdditive();
    if (index !== tokens.length) {
        throw new SyntaxError("Unexpected token");
    }
    return result;
}

function formatNumber(value) {
    const rounded = Number(value.toPrecision(15));
    return Object.is(rounded, -0) ? "0" : String(rounded);
}

function evaluateMathPrompt(prompt) {
    const expression = extractArithmeticExpression(prompt);
    if (!expression) return { matched: false };

    try {
        const value = guardResult(parseTokens(tokenize(expression)));
        return {
            matched: true,
            value,
            display: formatNumber(value)
        };
    } catch (error) {
        if (error instanceof LocalMathError) {
            return {
                matched: true,
                error: error.message
            };
        }
        return { matched: false };
    }
}

module.exports = {
    evaluateMathPrompt
};
