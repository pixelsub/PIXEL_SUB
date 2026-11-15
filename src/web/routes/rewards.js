// Admin API for the weekly top-spender rewards.
import express from 'express';
import { requireAuth } from '../auth.js';
import { getAllSettings, setSettings } from '../../services/settings.js';
import { rewardOverview, announceToggle } from '../../services/weekly_rewards.js';

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await rewardOverview());
});

// Save threshold / amounts / payout time.
router.put('/config', async (req, res) => {
  const b = req.body || {};
  const threshold = Number(b.threshold);
  if (!(threshold > 0)) return res.status(400).json({ error: 'Minimum spend must be greater than 0' });
  const amounts = String(b.amounts ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (!amounts.length || amounts.length > 10) return res.status(400).json({ error: 'Enter reward amounts like 5,3,2 (1st, 2nd, 3rd…)' });
  const time = String(b.time ?? '').trim();
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Payout time must look like 20:00' });
  await setSettings({ weekly_reward_threshold: threshold, weekly_reward_amounts: amounts.join(','), weekly_reward_time: time });
  res.json(await rewardOverview());
});

// Turn the program on/off. Every user is messaged when the state changes.
router.post('/toggle', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const s = await getAllSettings(true);
  if ((s.weekly_reward_enabled === 'true') === enabled) return res.json(await rewardOverview());
  await setSettings({ weekly_reward_enabled: enabled ? 'true' : 'false' });
  await announceToggle(enabled); // fire-and-forget DM to all users
  res.json(await rewardOverview());
});

export default router;
