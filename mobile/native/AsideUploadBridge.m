#import <React/RCTBridgeModule.h>
@interface RCT_EXTERN_MODULE(AsideUpload, NSObject)
RCT_EXTERN_METHOD(start:(NSString *)id base:(NSString *)base token:(NSString *)token uri:(NSString *)uri size:(NSNumber *)size partSize:(NSNumber *)partSize resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(status:(NSString *)id resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(cancel:(NSString *)id resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
