// Give existing products the premium emoji of their brand (YouTube, ChatGPT,
// CapCut, …) based on the product name. Products that already have a premium
// emoji are left alone.
//
//   node scripts/apply_brand_emoji.js          dry run: only lists the changes
//   node scripts/apply_brand_emoji.js --apply  writes them to the database
import prisma from '../src/db.js';
import { brandEmoji, parseEmoji } from '../src/emoji.js';

const apply = process.argv.includes('--apply');
const products = await prisma.product.findMany({ select: { id: true, name: true, emoji: true } });
let n = 0;
for (const p of products) {
  if (parseEmoji(p.emoji).id) continue;
  const next = brandEmoji(p.name);
  if (!next) continue;
  n++;
  console.log(`${apply ? 'UPDATE' : 'would update'} #${p.id} ${p.name}: ${p.emoji} -> ${next}`);
  if (apply) await prisma.product.update({ where: { id: p.id }, data: { emoji: next } });
}
console.log(`${n} product(s) ${apply ? 'updated' : 'would change (re-run with --apply)'}`);
await prisma.$disconnect();
