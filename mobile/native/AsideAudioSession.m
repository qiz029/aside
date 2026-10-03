#import <React/RCTBridgeModule.h>
#import <React/RCTBridge.h>
#import <React/RCTEventEmitter.h>
#import <WebRTCModule.h>
#import "AsideSilentAudioDevice.h"
#import <UIKit/UIKit.h>
#import <AVFAudio/AVFAudio.h>

// Expo owns podcast playback/recording. WebRTC may run its audio unit only
// while the serialized JS audio coordinator has granted answer playback.
@interface AsideAudioSession : RCTEventEmitter <RCTBridgeModule>
@end

@implementation AsideAudioSession
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"AsideAnswerInterrupted"]; }
- (void)startObserving {
  [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(interrupted:)
    name:@"AsideAnswerInterrupted" object:nil];
}
- (void)stopObserving { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (void)interrupted:(NSNotification *)notification {
  [self sendEventWithName:@"AsideAnswerInterrupted" body:nil];
}

RCT_EXPORT_METHOD(questionHeard) {
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
  // Recording otherwise suppresses feedback. Restore the session's preference
  // afterwards so subsequent keyboard/system sounds remain suppressed.
  AVAudioSession *session = [AVAudioSession sharedInstance];
  BOOL allowed = session.allowHapticsAndSystemSoundsDuringRecording;
  [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
  UIImpactFeedbackGenerator *feedback = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
  [feedback impactOccurred];
  if (!allowed) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [session setAllowHapticsAndSystemSoundsDuringRecording:NO error:nil];
  });
}

RCT_EXPORT_METHOD(configureVoiceChat:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  // Called with the engine stopped and session inactive, after Expo's defaults.
  // A2DP + the phone mic has no echo cancellation. Permit the car/headset's HFP
  // input/output instead; never force the built-in speaker over an accessory.
  AVAudioSessionCategoryOptions options = AVAudioSessionCategoryOptionDefaultToSpeaker;
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
  options |= AVAudioSessionCategoryOptionAllowBluetoothHFP;
#else
  options |= AVAudioSessionCategoryOptionAllowBluetooth;
#endif
  NSError *error;
  if (![[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayAndRecord
      mode:AVAudioSessionModeVoiceChat options:options error:&error]) {
    reject(@"voice_route", @"Couldn't configure hands-free audio", error);
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(setAnswerEnabled:(BOOL)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  if (![[AsideSilentAudioDevice shared] setAnswerEnabled:enabled error:&error]) {
    reject(@"answer_audio", @"Couldn't start answer playback", error);
    return;
  }
  resolve(nil);
}

RCT_EXPORT_METHOD(createSilentTrack:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  WebRTCModule *module = [self.bridge moduleForClass:[WebRTCModule class]];
  if (!module) {
    reject(@"silent_track", @"WebRTC is unavailable", nil);
    return;
  }
  dispatch_async(module.workerQueue, ^{
    NSString *trackId = NSUUID.UUID.UUIDString;
    RTCAudioTrack *track = [module.peerConnectionFactory audioTrackWithTrackId:trackId];
    module.localTracks[trackId] = track;
    resolve(@{ @"id": trackId, @"kind": @"audio", @"enabled": @YES,
      @"remote": @NO, @"readyState": @"live", @"constraints": @{},
      @"settings": @{}, @"peerConnectionId": @(-1) });
  });
}
RCT_EXPORT_METHOD(setInputEnabled:(BOOL)enabled resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  if (![[AsideSilentAudioDevice shared] setInputEnabled:enabled error:&error]) {
    reject(@"input_audio", @"Couldn't start microphone input", error); return;
  }
  resolve(nil);
}
RCT_EXPORT_METHOD(resetOutput:(double)generation resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [[AsideSilentAudioDevice shared] resetOutput:(uint64_t)generation]; resolve(nil);
}
RCT_EXPORT_METHOD(outputCommand:(double)generation epoch:(double)epoch mode:(NSInteger)mode resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [[AsideSilentAudioDevice shared] outputCommand:mode generation:(uint64_t)generation epoch:(uint64_t)epoch]; resolve(nil);
}
RCT_EXPORT_METHOD(audioStatus:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  resolve([[AsideSilentAudioDevice shared] audioStatus]);
}
RCT_EXPORT_METHOD(startPcm:(double)generation resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  if (![[AsideSilentAudioDevice shared] startPcm:(uint64_t)generation error:&error]) {
    reject(@"pcm_audio", @"Couldn't start PCM audio", error); return;
  }
  resolve(nil);
}
RCT_EXPORT_METHOD(stopPcm:(double)generation resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [[AsideSilentAudioDevice shared] stopPcm:(uint64_t)generation]; resolve(nil);
}
RCT_EXPORT_METHOD(appendPcm:(double)generation epoch:(double)epoch data:(NSString *)data resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [[AsideSilentAudioDevice shared] appendPcm:data generation:(uint64_t)generation epoch:(uint64_t)epoch]; resolve(nil);
}
RCT_EXPORT_METHOD(takePcmInput:(double)generation resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSString *data = [[AsideSilentAudioDevice shared] takePcmInput:(uint64_t)generation];
  if (!data) { reject(@"pcm_overflow", @"Microphone transport stalled", nil); return; }
  resolve(data);
}
@end
