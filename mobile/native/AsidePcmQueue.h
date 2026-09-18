#ifndef ASIDE_PCM_QUEUE_H
#define ASIDE_PCM_QUEUE_H
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// Single native audio thread; the owning adapter serializes commands/snapshots.
// Sample counters include interleaved channels. No allocation in the audio callback.
enum AsidePcmMode { AsideDiscard, AsideHold, AsidePlay, AsideOverflow };
typedef struct {
  int16_t *data;
  uint32_t rate, capacity, preroll, head, size, audible;
  uint64_t received, played, through, discarded, quiet;
  uint32_t overflows;
  enum AsidePcmMode mode;
  int started, active;
} AsidePcmQueue;

static inline void AsidePcmClear(AsidePcmQueue *q) {
  q->discarded += q->size;
  q->head = q->size = q->audible = 0;
  q->started = q->active = 0;
  q->quiet = 0;
}
static inline int AsidePcmInit(AsidePcmQueue *q, uint32_t rate, uint32_t seconds) {
  memset(q, 0, sizeof(*q));
  if (!rate || rate > 192000 || !seconds || seconds > 30) return 0;
  q->rate = rate; q->capacity = rate * seconds; q->preroll = rate / 5;
  q->data = calloc(q->capacity, sizeof(int16_t));
  return q->data != NULL;
}
static inline void AsidePcmCommand(AsidePcmQueue *q, enum AsidePcmMode mode) {
  // Overflow is terminal until a new connection resets the queue.
  if (q->mode == AsideOverflow) return;
  if (mode == AsideDiscard) AsidePcmClear(q);
  if (mode != AsideHold || q->mode == AsideDiscard) q->mode = mode;
}
static inline void AsidePcmProcess(AsidePcmQueue *q, int16_t *pcm, uint32_t count) {
  q->received += count;
  if (q->mode == AsideDiscard || q->mode == AsideOverflow) {
    q->discarded += count;
    memset(pcm, 0, count * sizeof(int16_t));
    return;
  }
  for (uint32_t i = 0; i < count; i++) {
    int16_t value = pcm[i];
    if (abs(value) > 3) q->started = 1;
    if (q->mode == AsideHold && !q->started && q->size >= q->preroll) {
      q->head = (q->head + 1) % q->capacity; q->size--; q->discarded++;
    }
    if (q->size == q->capacity) {
      AsidePcmClear(q); q->mode = AsideOverflow; q->overflows++;
      memset(pcm, 0, count * sizeof(int16_t)); return;
    }
    q->data[(q->head + q->size++) % q->capacity] = value;
    if (abs(value) > 32) q->audible++;
  }
  memset(pcm, 0, count * sizeof(int16_t));
  double energy = 0;
  if (q->mode == AsidePlay) {
    uint32_t read = count < q->size ? count : q->size;
    for (uint32_t i = 0; i < read; i++) {
      int16_t value = q->data[q->head];
      pcm[i] = value;
      energy += (double)value * value;
      if (abs(value) > 32) q->audible--;
      q->head = (q->head + 1) % q->capacity;
    }
    q->size -= read; q->played += read; q->through = q->received - q->size;
  }
  int loud = count && energy / count > (32768.0 * 0.008) * (32768.0 * 0.008);
  q->quiet = loud ? 0 : q->quiet + count;
  q->active = q->mode == AsidePlay && (loud || (q->active && q->quiet < q->rate * 0.9));
}
static inline int AsidePcmDrained(AsidePcmQueue *q) {
  return q->mode == AsidePlay && q->played > 0 && !q->active &&
    q->audible == 0 && q->quiet >= q->rate * 0.9;
}
#endif
