import { createHash } from 'node:crypto';
import type { EvidenceFieldRef, EvidenceFieldType, RawChannelInput } from './types';

export const CANONICAL_EVIDENCE_SCHEMA_VERSION = 'canonical-evidence-v2';

export interface CanonicalEvidenceDocument {
  id: string;
  field: EvidenceFieldType;
  index?: number;
  text: string;
  language?: string;
  script?: string;
  publishedAt?: string;
  contentType?: string;
  sourceFamilyId: string;
  sourceEntityId?: string;
  providerNativeId?: string;
  provenance?: Record<string,unknown>;
}

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const family=(kind:string,locator:string)=>`canonical:${kind}:${digest(locator).slice(0,24)}`;
const id=(field:EvidenceFieldType,index:number|undefined,text:string,sourceFamilyId:string,providerNativeId?:string)=>digest(`${CANONICAL_EVIDENCE_SCHEMA_VERSION}|${field}|${index??''}|${sourceFamilyId}|${providerNativeId||''}|${text.normalize('NFKC')}`);

/** Builds the one immutable, field-aware projection consumed by evidence providers. */
export function buildCanonicalEvidenceCorpus(input:RawChannelInput):CanonicalEvidenceDocument[]{
  const channelLocator=input.channel_id||input.channel_entity_id||`${input.channel_name}|${input.country||'UNKNOWN'}`;
  const channelFamily=input.channel_source_family_id||family('channel',channelLocator);
  const hints=input.detected_languages||[];
  const hint=(field:EvidenceFieldType)=>hints.find(item=>item.field===field)||hints.find(item=>!item.field);
  const out:CanonicalEvidenceDocument[]=[];
  const add=(field:EvidenceFieldType,text:string|undefined,options:Partial<CanonicalEvidenceDocument>={})=>{
    const normalized=String(text||'').normalize('NFKC').trim();if(!normalized)return;
    const language=options.language||hint(field)?.language;
    const sourceFamilyId=options.sourceFamilyId||channelFamily;
    out.push({id:id(field,options.index,normalized,sourceFamilyId,options.providerNativeId),field,index:options.index,text:normalized,language,script:options.script,publishedAt:options.publishedAt,contentType:options.contentType,sourceFamilyId,sourceEntityId:options.sourceEntityId||input.channel_entity_id,providerNativeId:options.providerNativeId,provenance:options.provenance});
  };
  add('channel_title',input.channel_name,{providerNativeId:input.channel_id});add('channel_bio',input.description,{providerNativeId:input.channel_id});add('country',input.country,{providerNativeId:input.channel_id});
  hints.forEach((languageHint,index)=>add('language',languageHint.language,{index,language:languageHint.language,providerNativeId:input.channel_id}));
  const videos=input.videos?.length?input.videos:(input.video_titles||[]).map((title,index)=>({title,description:input.video_descriptions?.[index]}));
  videos.forEach((video,index)=>{const locator=('id'in video&&video.id)||`${channelLocator}:video:${index}`,sourceFamilyId=('source_family_id'in video&&video.source_family_id)||family('video',locator),sourceEntityId=('source_entity_id'in video&&video.source_entity_id)||input.channel_entity_id,common={index,language:video.language,script:video.script,publishedAt:'published_at'in video?video.published_at:undefined,contentType:'content_type'in video?video.content_type:undefined,sourceFamilyId,sourceEntityId,providerNativeId:'id'in video?video.id:undefined};add('video_title',video.title,common);add('video_description',video.description,common);});
  (input.playlists||[]).forEach((playlist,index)=>{const sourceFamilyId=family('playlist',playlist.id||`${channelLocator}:playlist:${index}`);add('playlist_name',playlist.name,{index,sourceFamilyId,providerNativeId:playlist.id});add('playlist_description',playlist.description,{index,sourceFamilyId,providerNativeId:playlist.id});});
  (input.transcript_excerpts||[]).forEach((excerpt,index)=>{const video=videos.find(candidate=>'id'in candidate&&candidate.id===excerpt.video_id),sourceFamilyId=video&&'source_family_id'in video&&video.source_family_id?video.source_family_id:family('video',excerpt.video_id||`${channelLocator}:transcript:${index}`);add('transcript_excerpt',excerpt.text,{index,language:excerpt.language,sourceFamilyId,providerNativeId:excerpt.video_id});});
  (input.external_link_details||[]).forEach((link,index)=>{const sourceFamilyId=link.source_family_id||family('link',link.url);add('external_link_label',link.label,{index,sourceFamilyId,sourceEntityId:link.source_entity_id});add('external_link_domain',link.domain||link.url,{index,sourceFamilyId,sourceEntityId:link.source_entity_id});});
  if(!input.external_link_details?.length)(input.external_links||[]).forEach((url,index)=>add('external_link_domain',url,{index,sourceFamilyId:family('link',url)}));
  (input.visual_evidence||[]).forEach((visual,index)=>add('visual_evidence',visual.description,{index,sourceFamilyId:family('visual',visual.source_ref),providerNativeId:visual.source_ref,provenance:{modelProvenance:visual.model_provenance}}));
  add('location',input.location_tag);
  if(input.discord_invite)add('discord_invite',input.discord_invite,{sourceFamilyId:family('community',input.discord_invite)});
  add('pinned_comment',input.pinned_comment);
  if(input.activity_metadata)add('activity_metadata',JSON.stringify(input.activity_metadata));
  if(input.search_match_context){const context=input.search_match_context,sourceFamilyId=family('search-match',context.provider_native_id||context.locator||`${channelLocator}:search-match`);add('search_match_context',[context.title,context.description].filter(Boolean).join('\n'),{sourceFamilyId,providerNativeId:context.provider_native_id,publishedAt:context.published_at,contentType:'search_match'});}
  return out;
}

export function documentRef(document:CanonicalEvidenceDocument):EvidenceFieldRef{return {field:document.field,index:document.index,sourceId:document.id,sourceFamilyId:document.sourceFamilyId,sourceEntityId:document.sourceEntityId,publishedAt:document.publishedAt,contentType:document.contentType};}

export function validateEvidenceProvenance(items:Array<{rawMatches:string[];provenance?:{fields?:EvidenceFieldRef[]}}>):string[]{return items.flatMap((item,index)=>item.rawMatches.length&&!(item.provenance?.fields?.length)?[`EVIDENCE_${index}_MISSING_ATTRIBUTION`]:[]);}
