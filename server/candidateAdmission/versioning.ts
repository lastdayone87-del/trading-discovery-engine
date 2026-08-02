import {stableChecksum} from '../replayMeasurement';
export const admissionChecksum=(value:unknown)=>stableChecksum(value);
export function deterministicUuid(namespace:string,value:string):string{const hex=stableChecksum(`${namespace}|${value}`).slice(0,32).split('');hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;}
