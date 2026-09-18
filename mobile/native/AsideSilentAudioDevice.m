#import "AsideSilentAudioDevice.h"
#import <AVFoundation/AVFoundation.h>
#import <WebRTCModuleOptions.h>
#import <UIKit/UIKit.h>
#import <os/lock.h>
#import "AsidePcmQueue.h"

@interface AsideSilentAudioDevice ()
@property(nonatomic, strong) id<RTCAudioDeviceDelegate> delegate;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) AVAudioSourceNode *source;
@property(nonatomic, strong) id configurationObserver;
@property(nonatomic, strong) NSMutableArray *interruptObservers;
@property(atomic) BOOL allowed;
@property(atomic) BOOL playing;
@property(atomic) BOOL recording;
@property(atomic) BOOL inputEnabled;
@property(atomic) double inputLevel;
@property(nonatomic) BOOL inputTap;
@property(nonatomic, strong) AVAudioConverter *inputConverter;
@property(nonatomic, strong) AVAudioPCMBuffer *inputBuffer;
@end

@implementation AsideSilentAudioDevice {
  AsidePcmQueue _pcmQueue;
  os_unfair_lock _pcmLock;
  uint64_t _generation, _epoch;
}
- (instancetype)init {
  if ((self = [super init])) {
    _pcmLock = OS_UNFAIR_LOCK_INIT;
    if (!AsidePcmInit(&_pcmQueue, 48000, 30)) return nil;
  }
  return self;
}
- (void)dealloc { free(_pcmQueue.data); }
+ (instancetype)shared {
  static AsideSilentAudioDevice *device;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ device = [AsideSilentAudioDevice new]; });
  return device;
}
+ (void)load {
  // Must precede WebRTCModule's peer-connection factory initialization.
  [WebRTCModuleOptions sharedInstance].audioDevice = [self shared];
}
- (double)deviceInputSampleRate { return 48000; }
- (double)deviceOutputSampleRate { return 48000; }
- (NSTimeInterval)inputIOBufferDuration { return 0.01; }
- (NSTimeInterval)outputIOBufferDuration { return 0.01; }
- (NSInteger)inputNumberOfChannels { return 1; }
- (NSInteger)outputNumberOfChannels { return 1; }
- (NSTimeInterval)inputLatency { return 0; }
- (NSTimeInterval)outputLatency { return [AVAudioSession sharedInstance].outputLatency; }
- (BOOL)isInitialized { return self.delegate != nil; }
- (BOOL)isPlayoutInitialized { return self.isInitialized; }
- (BOOL)isRecordingInitialized { return self.isInitialized; }
- (BOOL)isPlaying { return self.playing; }
- (BOOL)isRecording { return self.recording; }
- (BOOL)initializePlayout { return YES; }
- (BOOL)initializeRecording { return YES; }

- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
  self.delegate = delegate;
  self.engine = [AVAudioEngine new];
  AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:1];
  __weak AsideSilentAudioDevice *weakSelf = self;
  self.source = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:
    ^OSStatus(BOOL *silence, const AudioTimeStamp *timestamp, AVAudioFrameCount count, AudioBufferList *output) {
      AsideSilentAudioDevice *device = weakSelf;
      // AVAudioEngine supplies the pacing; no JS timers and no capture device.
      SInt16 pcm[8192] = {0};
      if (count > 8192) return kAudioUnitErr_TooManyFramesToProcess;
      AudioBufferList buffer = { .mNumberBuffers = 1,
        .mBuffers = {{ .mNumberChannels = 1, .mDataByteSize = count * sizeof(SInt16), .mData = pcm }} };
      AudioUnitRenderActionFlags flags = 0;
      id<RTCAudioDeviceDelegate> target = device.delegate;
      if (device.allowed && device.recording && !device.inputEnabled && target)
        target.deliverRecordedData(&flags, timestamp, 0, count, &buffer, NULL, nil);
      if (device.allowed && device.playing && target)
        target.getPlayoutData(&flags, timestamp, 0, count, &buffer);
      os_unfair_lock_lock(&device->_pcmLock);
      AsidePcmProcess(&device->_pcmQueue, pcm, count);
      os_unfair_lock_unlock(&device->_pcmLock);
      for (UInt32 channel = 0; channel < output->mNumberBuffers; channel++) {
        float *samples = output->mBuffers[channel].mData;
        for (UInt32 i = 0; i < count; i++) samples[i] = pcm[i] / 32768.0f;
      }
      *silence = !device.playing;
      return noErr;
    }];
  [self.engine attachNode:self.source];
  [self.engine connect:self.source to:self.engine.mainMixerNode format:format];
  self.configurationObserver = [[NSNotificationCenter defaultCenter]
    addObserverForName:AVAudioEngineConfigurationChangeNotification object:self.engine queue:nil
    usingBlock:^(NSNotification *note) {
      AsideSilentAudioDevice *device = weakSelf;
      [device.delegate dispatchAsync:^{
        [device.delegate notifyAudioInputInterrupted];
        [device.delegate notifyAudioOutputInterrupted];
        if (device.allowed && (device.playing || device.recording))
          [device.engine startAndReturnError:nil];
      }];
    }];
  self.interruptObservers = [NSMutableArray new];
  for (NSString *name in @[AVAudioSessionInterruptionNotification,
                           AVAudioSessionRouteChangeNotification,
                           UIApplicationDidEnterBackgroundNotification]) {
    id observer = [[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:nil
      usingBlock:^(NSNotification *note) {
        BOOL interruption = [name isEqual:AVAudioSessionInterruptionNotification] &&
          [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
        BOOL unplugged = [name isEqual:AVAudioSessionRouteChangeNotification] &&
          [note.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;
        BOOL background = [name isEqual:UIApplicationDidEnterBackgroundNotification];
        if (!interruption && !unplugged && !background) return;
        AsideSilentAudioDevice *device = weakSelf;
        if (!device.allowed) return;
        [device setAnswerEnabled:NO error:nil];
        [device setInputEnabled:NO error:nil];
        // AppState handles background cancellation. Route/call changes also
        // need to cancel the JS question and hold the podcast at its anchor.
        if (!background) dispatch_async(dispatch_get_main_queue(), ^{
          [[NSNotificationCenter defaultCenter] postNotificationName:@"AsideAnswerInterrupted" object:nil];
        });
      }];
    [self.interruptObservers addObject:observer];
  }
  if (self.inputEnabled && ![self configureInput:YES error:nil]) return NO;
  return YES;
}
- (BOOL)updateEngine:(NSError **)error {
  if (self.allowed && (self.playing || self.recording)) {
    if (!self.engine.isRunning) return [self.engine startAndReturnError:error];
  } else {
    [self.engine stop];
    [self.delegate notifyAudioInputInterrupted];
    [self.delegate notifyAudioOutputInterrupted];
  }
  return YES;
}
- (BOOL)setAnswerEnabled:(BOOL)enabled error:(NSError **)error {
  __block BOOL success = YES;
  __block NSError *failure;
  if (self.delegate) {
    [self.delegate dispatchSync:^{
      self.allowed = enabled;
      success = [self updateEngine:&failure];
    }];
  } else self.allowed = enabled;
  if (error) *error = failure;
  return success;
}
- (BOOL)configureInput:(BOOL)enabled error:(NSError **)error {
  BOOL hadInput = self.inputEnabled || self.inputTap;
  self.inputEnabled = NO;
  self.inputLevel = 0;
  if (!self.engine) { self.inputEnabled = enabled; return YES; }
  [self.engine stop];
  [self.delegate notifyAudioInputInterrupted];
  [self.delegate notifyAudioOutputInterrupted];
  if (self.inputTap) [self.engine.inputNode removeTapOnBus:0];
  self.inputTap = NO;
  self.inputConverter = nil; self.inputBuffer = nil;
  if (!enabled) {
    if (hadInput) return [self.engine.inputNode setVoiceProcessingEnabled:NO error:error];
    return YES;
  }
  AVAudioInputNode *input = self.engine.inputNode;
  // Echo cancellation uses the hardware output reference, including the podcast.
  if (![input setVoiceProcessingEnabled:YES error:error]) return NO;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.sampleRate <= 0 || format.channelCount < 1) {
    if (error) *error = [NSError errorWithDomain:@"AsideAudio" code:1
      userInfo:@{NSLocalizedDescriptionKey:@"Microphone input is unavailable"}];
    return NO;
  }
  AVAudioFormat *targetFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
    sampleRate:48000 channels:1 interleaved:YES];
  self.inputConverter = [[AVAudioConverter alloc] initFromFormat:format toFormat:targetFormat];
  self.inputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFormat frameCapacity:8192];
  __weak AsideSilentAudioDevice *weakSelf = self;
  [input installTapOnBus:0 bufferSize:480 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    AsideSilentAudioDevice *device = weakSelf;
    if (!device.allowed || !device.inputEnabled || !device.recording) return;
    __block BOOL supplied = NO;
    NSError *failure;
    AVAudioConverterOutputStatus status = [device.inputConverter convertToBuffer:device.inputBuffer
      error:&failure withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *state) {
        *state = supplied ? AVAudioConverterInputStatus_NoDataNow : AVAudioConverterInputStatus_HaveData;
        if (supplied) return nil;
        supplied = YES; return buffer;
      }];
    if (failure || status == AVAudioConverterOutputStatus_Error || !device.inputEnabled) return;
    AVAudioFrameCount count = device.inputBuffer.frameLength;
    double energy = 0;
    SInt16 *samples = device.inputBuffer.int16ChannelData[0];
    for (UInt32 i = 0; i < count; i++) energy += (double)samples[i] * samples[i];
    device.inputLevel = count ? sqrt(energy / count) / 32768.0 : 0;
    AudioUnitRenderActionFlags flags = 0;
    AudioTimeStamp timestamp = when.audioTimeStamp;
    if (count && device.allowed && device.inputEnabled)
      device.delegate.deliverRecordedData(&flags, &timestamp, 0, count,
        device.inputBuffer.audioBufferList, NULL, nil);
  }];
  self.inputTap = YES; self.inputEnabled = YES;
  return YES;
}
- (BOOL)setInputEnabled:(BOOL)enabled error:(NSError **)error {
  __block BOOL success = YES;
  __block NSError *failure;
  if (self.delegate) [self.delegate dispatchSync:^{ success = [self configureInput:enabled error:&failure]; }];
  else self.inputEnabled = enabled;
  if (error) *error = failure;
  return success;
}
- (void)resetOutput:(uint64_t)generation {
  os_unfair_lock_lock(&_pcmLock);
  if (generation < _generation) { os_unfair_lock_unlock(&_pcmLock); return; }
  free(_pcmQueue.data); AsidePcmInit(&_pcmQueue, 48000, 30);
  _generation = generation; _epoch = 0;
  os_unfair_lock_unlock(&_pcmLock);
}
- (void)outputCommand:(NSInteger)mode generation:(uint64_t)generation epoch:(uint64_t)epoch {
  os_unfair_lock_lock(&_pcmLock);
  if (_generation == generation && epoch >= _epoch && mode >= AsideDiscard && mode <= AsidePlay) {
    _epoch = epoch; AsidePcmCommand(&_pcmQueue, (enum AsidePcmMode)mode);
  }
  os_unfair_lock_unlock(&_pcmLock);
}
- (NSDictionary *)audioStatus {
  os_unfair_lock_lock(&_pcmLock);
  NSDictionary *status = @{
    @"mode": @(_pcmQueue.mode), @"active": @((BOOL)(_pcmQueue.active != 0)),
    @"drained": @((BOOL)(AsidePcmDrained(&_pcmQueue) != 0)), @"overflows": @(_pcmQueue.overflows),
    @"receivedFrames": @(_pcmQueue.received), @"playedThroughFrame": @(_pcmQueue.through),
    @"bufferedMs": @((double)_pcmQueue.size * 1000 / _pcmQueue.rate),
    @"generation": @(_generation), @"inputLevel": @(self.inputLevel)
  };
  os_unfair_lock_unlock(&_pcmLock);
  return status;
}
- (BOOL)startPlayout { self.playing = YES; return [self updateEngine:nil]; }
- (BOOL)stopPlayout { self.playing = NO; return [self updateEngine:nil]; }
- (BOOL)startRecording { self.recording = YES; return [self updateEngine:nil]; }
- (BOOL)stopRecording { self.recording = NO; return [self updateEngine:nil]; }
- (BOOL)terminateDevice {
  self.playing = NO; self.recording = NO;
  [self.engine stop];
  if (self.configurationObserver) [[NSNotificationCenter defaultCenter] removeObserver:self.configurationObserver];
  for (id observer in self.interruptObservers) [[NSNotificationCenter defaultCenter] removeObserver:observer];
  self.interruptObservers = nil;
  self.configurationObserver = nil;
  self.source = nil; self.engine = nil; self.delegate = nil;
  return YES;
}
@end
