#import <React/RCTBridgeModule.h>
@interface RCT_EXTERN_MODULE(AsidePodcastInbox, NSObject)
RCT_EXTERN_METHOD(list:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(remove:(NSString *)id resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
