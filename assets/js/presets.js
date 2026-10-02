// Vocal presets: a starting point for the whole chain (tuning, tone, space, stacks) in one pick.
// Three are free. The rest are part of Pro.
export const PRESETS = [
  {
    id: 'clean', name: 'Clean and natural', pro: false,
    about: 'Light tuning and a clear, close vocal. A safe start for any song.',
    tune: { speedMs: 45, amount: 80, keepVibrato: 60 },
    mix: { hpf: 90, body: 0, presence: 2, air: 2, sibilance: 3, comp: 40, warmth: 10, reverb: 14, delay: 0, gate: 0 },
  },
  {
    id: 'melodic', name: 'Melodic rap', pro: false,
    about: 'Fast tuning you can hear, bright top end, echo trailing each line.',
    tune: { speedMs: 12, amount: 100, keepVibrato: 20 },
    mix: { hpf: 110, body: -1, presence: 3.5, air: 4, sibilance: 4, comp: 60, warmth: 20, reverb: 20, delay: 22, gate: 0 },
  },
  {
    id: 'hard', name: 'Hard tune', pro: false,
    about: 'Instant, robotic snapping to every note.',
    tune: { speedMs: 0, amount: 100, keepVibrato: 0 },
    mix: { hpf: 120, body: -1.5, presence: 4, air: 5, sibilance: 5, comp: 70, warmth: 25, reverb: 24, delay: 18, gate: 0 },
  },
  {
    id: 'rnb', name: 'R&B silk', pro: true,
    about: 'Smooth and airy with your vibrato kept, a long reverb and a soft third above.',
    tune: { speedMs: 60, amount: 85, keepVibrato: 80 },
    mix: { hpf: 85, body: 1.5, presence: 1.5, air: 5, sibilance: 4.5, comp: 50, warmth: 18, reverb: 34, delay: 10, gate: 0 },
    stack: { double: 25, harmony: 'thirdUp', harmonyLevel: 35 },
  },
  {
    id: 'drill', name: 'Drill and dark trap', pro: true,
    about: 'Dry, forward and aggressive, with a tight double for weight.',
    tune: { speedMs: 18, amount: 90, keepVibrato: 15 },
    mix: { hpf: 100, body: 2, presence: 4.5, air: 1.5, sibilance: 4, comp: 80, warmth: 40, reverb: 8, delay: 6, gate: 20 },
    stack: { double: 45, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'hook', name: 'Stadium hook', pro: true,
    about: 'A wall of voices for the chorus: wide doubles, a third above and a big room.',
    tune: { speedMs: 10, amount: 100, keepVibrato: 25 },
    mix: { hpf: 110, body: 0, presence: 3, air: 4.5, sibilance: 4.5, comp: 65, warmth: 22, reverb: 30, delay: 16, gate: 0 },
    stack: { double: 75, harmony: 'thirdUp', harmonyLevel: 55 },
  },
  {
    id: 'radio', name: 'Radio pop', pro: true,
    about: 'Polished and present, tuned so it sounds right without sounding tuned.',
    tune: { speedMs: 28, amount: 95, keepVibrato: 45 },
    mix: { hpf: 100, body: 0.5, presence: 3.5, air: 4, sibilance: 5, comp: 72, warmth: 15, reverb: 18, delay: 10, gate: 10 },
    stack: { double: 30, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'lofi', name: 'Lo-fi tape', pro: true,
    about: 'Warm and worn, rolled-off top, heavy saturation.',
    tune: { speedMs: 70, amount: 60, keepVibrato: 85 },
    mix: { hpf: 140, body: 2.5, presence: 0, air: -4, sibilance: 2, comp: 55, warmth: 75, reverb: 22, delay: 14, gate: 0 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'spoken', name: 'Spoken word and podcast', pro: true,
    about: 'No tuning. Even, clear speech with room noise held down.',
    tune: { enabled: false },
    mix: { hpf: 80, body: 1, presence: 2.5, air: 1.5, sibilance: 5, comp: 68, warmth: 8, reverb: 0, delay: 0, gate: 35 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
];
