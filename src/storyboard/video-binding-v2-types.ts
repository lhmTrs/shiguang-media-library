export type VideoV2Status='available'|'missing'|'changed'|'untrusted'|'unsupported'|'unchecked';
export interface VideoV2Context {instanceId:string;projectId:string;documentId:string|null;initializedAt:number|null;storyboardRevision:number|null;assetStamp:string|null;selectionRevision:number}
export type ReviewCategory='framing'|'action'|'camera'|'duration'|'first_frame'|'continuity'|'sound_dialogue'|'characters'|'references'|'audio_continuation'|'scene'|'shot_range'|'video_content'|'dependency_unverifiable';
export interface ReviewReason {category:ReviewCategory;shotIds:string[]}
export interface Provenance {provenanceId:string;instanceId:string;projectId:string;documentId:string;initializedAt:number;storyboardRevision:number;shotIds:string[];createdAt:number;inputHash:string}
export interface BoundShot {shotId:string;numberAtBinding:string;durationMs:number;associationSeq:number;existsInCurrent:boolean;currentNumber:string|null}
export interface VideoV2Binding {bindingId:string;revision:number;targetProjectId:string;documentId:string;initializedAt:number;storyboardRevision:number;boundAt:number;origin:'agent'|'manual';provenance:Provenance|null;shots:BoundShot[]}
export interface VideoV2Review {needsReview:boolean;reasons:ReviewReason[];reviewedToRevision:number|null;reviewedAt:number|null;comparisonHash:string;canReview:boolean;disabledReason:string|null}
export interface SelectionView {videoId:string;sourceProjectId:string;bindingId:string;name:string;kind:'whole'|'shot';selectedAt:number}
export interface ShotVideoState {shotId:string;number:string;adopted:SelectionView|null;defaultVideo:{videoId:string;sourceProjectId:string;bindingId:string;name:string}|null;candidateCount:number;newVideoCount:number;needsReview:boolean;reviewReasons:ReviewReason[]}
export interface VideoV2State {schemaVersion:2;initialized:boolean;context:VideoV2Context;migration:Record<string,unknown>;shots:ShotVideoState[]}
export interface ShotVideoItem {videoId:string;sourceProjectId:string;name:string;durationMs:number;status:VideoV2Status;errorCode:string|null;mediaUrl:string;thumbnailUrl:string|null;videoRevision:number;binding:VideoV2Binding;review:VideoV2Review}
export interface ShotVideoPage {context:VideoV2Context;shotId:string;total:number;offset:number;limit:number;items:ShotVideoItem[]}
export interface SourceVideoBinding {sourceProjectId:string;videoId:string;videoRevision:number;bindingRevision:number;binding:VideoV2Binding|null;review:VideoV2Review|null;allowedTargets:{projectId:string;name:string;seriesId:string|null}[];context:VideoV2Context|null}
export interface BindingIntent {action:'bind'|'unbind';expectedBindingRevision:number;targetProjectId:string|null;expectedStoryboardRevision:number|null;expectedAssetStamp:string|null;shotIds:string[]}
export interface SelectionIntent {action:'adopt-video'|'adopt-shot'|'clear-video'|'clear-shot';expectedSelectionRevision:number;expectedStoryboardRevision:number;sourceProjectId?:string;videoId?:string;bindingId?:string;expectedBindingRevision?:number;shotId?:string}
export interface SelectionChange {projectId:string;shotId:string;number:string;before:SelectionView|null;after:SelectionView|null}
export interface AffectedBindingShot extends SelectionChange {projectName:string}
export interface BindingPreview {previewHash:string;before:VideoV2Binding|null;after:VideoV2Binding|null;contexts:VideoV2Context[];affectedShots:AffectedBindingShot[];requiresConfirmation:boolean}
export interface SelectionPreview {context:VideoV2Context;previewHash:string;requiresConfirmation:boolean;changes:SelectionChange[]}
export interface BindingWrite extends BindingIntent {requestId:string;previewHash:string;confirmUnbind?:true;confirmedUnbindShotIds?:string[]}
export interface SelectionWrite extends SelectionIntent {requestId:string;previewHash:string;confirmReplace?:true}
export interface BindingWriteResult {context:VideoV2Context|null;binding:VideoV2Binding|null;review:VideoV2Review|null;changes:AffectedBindingShot[];requestId:string;repeated:boolean}
export interface SelectionWriteResult {context:VideoV2Context;changes:SelectionChange[];requestId:string;repeated:boolean}
export interface ReviewWrite {requestId:string;action:'confirm'|'undo';expectedBindingRevision:number;seenStoryboardRevision:number;expectedComparisonHash:string}
export interface ReviewWriteResult {context:VideoV2Context;binding:VideoV2Binding;review:VideoV2Review;requestId:string;repeated:boolean}
