import {GenerationStore} from './store.mjs';
import {RuleLibrary} from './rules.mjs';
import {GenerationService} from './service.mjs';
import {generationRouter} from './router.mjs';
export async function createStoryboardGeneration({lib,storyboards,codex,projects,...options}){const store=new GenerationStore(lib,storyboards).init(),rules=new RuleLibrary(lib,fn=>store.tx(fn));await rules.seed();store.recover();if(projects)projects.generationLocks=store;const service=new GenerationService(store,rules,codex,options);return{store,rules,service,router:generationRouter(service)};}
