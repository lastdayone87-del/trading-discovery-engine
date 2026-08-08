export const REVIEW_REASON_CATALOG_VERSION='human-review-reasons-v1';
export type ReviewReasonAction='APPROVE'|'REJECT';
export interface ReviewReasonOption {code:string;label:string;allowsOther?:boolean}
export const REVIEW_REASON_CATALOG:Record<ReviewReasonAction,ReviewReasonOption[]>={
  APPROVE:[{code:'CONFIRMED_TRADING_CREATOR',label:'Confirmed trading creator'},{code:'STRONG_TRADING_EVIDENCE',label:'Strong trading evidence'},{code:'MANUAL_VERIFICATION_CONFIRMED',label:'Manual verification confirmed'},{code:'RELEVANT_TRADING_SPECIALIZATION',label:'Relevant trading specialization'},{code:'OTHER',label:'Other',allowsOther:true}],
  REJECT:[{code:'NOT_TRADING_CREATOR',label:'Not actually a trading creator'},{code:'PRIMARILY_NEWS_MEDIA',label:'Primarily news or media'},{code:'PERSONAL_FINANCE_INVESTING_ONLY',label:'Personal finance or investing only'},{code:'NON_TRADING_EDUCATION',label:'Non-trading educational content'},{code:'WRONG_CREATOR_CATEGORY',label:'Wrong creator or category'},{code:'DUPLICATE_CREATOR',label:'Duplicate creator'},{code:'INSUFFICIENT_TRADING_EVIDENCE',label:'Insufficient trading evidence'},{code:'OTHER',label:'Other',allowsOther:true}]
};
export function resolveReviewReason(action:ReviewReasonAction,code:string,version:string,otherText?:string){
  if(version!==REVIEW_REASON_CATALOG_VERSION)throw new Error('reviewReasonVersion is not supported.');
  const option=REVIEW_REASON_CATALOG[action].find(item=>item.code===code);if(!option)throw new Error('reviewReasonCode is not valid for this action.');
  const other=otherText?.trim();if(option.allowsOther&&!other)throw new Error('reviewReasonOther is required for Other.');if(!option.allowsOther&&other)throw new Error('reviewReasonOther is only permitted for Other.');
  return {code:option.code,label:option.label,version,otherText:other||undefined,display:other?`${option.label}: ${other}`:option.label};
}
