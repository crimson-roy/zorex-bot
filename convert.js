const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const root = "./data/stickers";

async function convert(dir) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const full = path.join(dir, file);

        if (fs.statSync(full).isDirectory()) {
            await convert(full);
            continue;
        }

        if (/\.(jpg|jpeg|png)$/i.test(file)) {
            const out = full.replace(/\.(jpg|jpeg|png)$/i, ".webp");

            await sharp(full)
                .resize(512, 512, { fit: "contain" })
                .webp({ quality: 95 })
                .toFile(out);

            console.log("Converted:", out);
        }
    }
}

convert(root);