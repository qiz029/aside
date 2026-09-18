#import <WebRTC/RTCAudioDevice.h>

// One foreground duplex device: buffered reply output, actual input in automatic
// mode, and a zero-PCM media clock without opening the mic in manual mode.
@interface AsideSilentAudioDevice : NSObject <RTCAudioDevice>
+ (instancetype)shared;
- (BOOL)setAnswerEnabled:(BOOL)enabled error:(NSError **)error;
- (BOOL)setInputEnabled:(BOOL)enabled error:(NSError **)error;
- (void)resetOutput:(uint64_t)generation;
- (void)outputCommand:(NSInteger)mode generation:(uint64_t)generation epoch:(uint64_t)epoch;
- (NSDictionary *)audioStatus;
@end
