import {randomUUID} from 'node:crypto';

// Independently written local API caller. No platform implementation or task queue.
export async function syntheticVideoCaller({api,upload,persist,afterReserve,projectId,shotIds,folderId,bytes}){
 const view=await api('/storyboard/projects/'+projectId);
 const reserved=await api('/storyboard-video/v2/projects/'+projectId+'/provenance',{requestId:randomUUID(),expectedStoryboardRevision:view.revision,expectedAssetStamp:view.asset_stamp,shotIds});
 const importId=randomUUID(),origin={provenanceId:reserved.provenance.provenanceId,expectedProvenanceRevision:reserved.revision};
 await persist({importId,origin,provenance:reserved.provenance});
 await afterReserve(view);
 await api('/project-videos/projects/'+projectId+'/imports',{requestId:importId,fileName:'synthetic-caller.mp4',folderId,bytes:bytes.length,storyboardOrigin:origin,prompt:{mode:'none'}});
 await upload('/project-videos/projects/'+projectId+'/imports/'+importId+'/content',bytes);
 const receipt=await api('/project-videos/projects/'+projectId+'/imports/'+importId);
 if(receipt.status!=='ready'||receipt.binding?.status!=='bound')throw Error('Synthetic local import not bound');
 const actual=await api('/storyboard-video/v2/source-projects/'+projectId+'/videos/'+receipt.videoId+'/binding');
 if(actual.binding?.provenance?.provenanceId!==origin.provenanceId||actual.binding.storyboardRevision!==reserved.provenance.storyboardRevision)throw Error('Synthetic local provenance readback mismatch');
 return {receipt,actual};
}
