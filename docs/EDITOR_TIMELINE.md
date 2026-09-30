# Zorex Editor Timeline v1

`timeline_v1` is Zorex's renderer-neutral edit format. The same edit plan can
be created by WhatsApp commands, Zorex AI, or a future visual editor and then
rendered by whichever worker has the required capabilities.

## Core model

- Timeline: canvas size, fps, duration, tracks.
- Track: video, audio, text, overlay, or adjustment.
- Clip: source, start, duration, trim, transforms, time-remap, freezes, masks,
  effects and metadata.
- Keyframes: time, value, easing. Supported easing includes linear, hold,
  ease/ease-in/ease-out/ease-in-out and cubic-bezier control points.
- Presets: persistent reusable clip/track/timeline instruction stacks. Source
  media is intentionally not embedded in a clip preset.

## First-class edit features

The schema already represents:

- split/trim/placement
- freeze segments
- transform and zoom/pan/rotation/opacity keyframes
- time-remapping by source-time keyframes
- rectangle/ellipse/polygon masks
- AI subject masks
- common color/blur/glow/motion-blur descriptors
- depth/depth-mist
- Real-ESRGAN upscale
- After Effects preset references

Not every descriptor has a renderer yet. A worker must advertise the required
capability before it may claim a job.

## After Effects

An effect with type `aftereffects_preset` can reference an installed AE preset.
A future AE worker can create/open a composition, apply the preset through AE
scripting and render it. Exact third-party effects require that plugin to be
installed and licensed on that worker.

Example:

```json
{
  "type": "aftereffects_preset",
  "params": {
    "preset": "sasuke reverse plus cc.ffx",
    "requiredPlugins": ["Sapphire"]
  }
}
```

This would require worker capabilities `aftereffects` and
`ae-plugin:sapphire`.

## Rotoscoping

A subject mask is represented as:

```json
{
  "type": "subject",
  "subject": { "method": "auto", "track": true }
}
```

The native renderer can later satisfy this with a segmentation/tracking model.
An AE worker may instead use an AE-specific workflow. The schema intentionally
does not pretend that After Effects Roto Brush itself is available on every
worker.

## Preset saving

Once a user has tuned time-remap, zoom keyframes, masks and effects, Zorex can
store that clip instruction stack as a `ZRP-...` preset. Applying it to a new
clip reuses the edit decisions without copying the old source video.
