/**
 * UW-3c — a broad list of English verbs in their base form, for recognising an instruction ("Designate a captain.", "Paste the
 * ship into an email.", "Bump last week's entry down.").
 *
 * The capability lexicon and `directive.ts`'s general action verbs are deliberately narrow, because they also NAME things
 * (a verb found mid-sentence becomes a capability). Telling whether an item OPENS with a verb is a different question, and a
 * narrow list fails it on ordinary procedures: real steps start with any verb at all. This list is language-level only (no
 * subject-matter vocabulary); a word that is also a noun ("Name", "Plan", "Break") is told apart by what follows it
 * (`directive.ts#isImperative`).
 */
const VERBS = `
  abandon abide abolish absorb abstain accelerate accept access accommodate accompany accomplish account accrue accumulate
  accuse achieve acknowledge acquire act activate adapt add address adhere adjust administer admire admit adopt advance
  advertise advise advocate affect affirm afford aggregate agree aid aim alert align allocate allow alter alternate amend
  analyse analyze anchor animate annotate announce annul answer anticipate apologize appeal appear append apply appoint
  appraise appreciate approach appropriate approve archive argue arise arrange arrest arrive articulate ascertain ask
  assemble assert assess assign assist associate assume assure attach attain attempt attend attest attract attribute audit
  augment authenticate authorise authorize automate avoid await award back backup balance ban bank bar base batch bathe
  be bear beat become begin behave believe belong bend benchmark benefit bet bid bill bind bite blame blank bleed blend
  bless block blog blow blur board boil bold book boost boot borrow bother bounce bound bow box brace brainstorm branch
  brand break brief brighten bring broadcast browse brush budget buffer build bump bundle burn bury buy calculate
  calibrate call calm cancel capitalize capture care carry cascade cast catalog catalogue catch categorize cater cause
  caution cease celebrate center centre certify chain chair challenge change channel characterize charge chart chase
  chat check cheer chew choose chop circle circulate cite claim clamp clarify classify clean cleanse clear click climb
  clip clone close coach code codify collaborate collapse collate collect color colour combine come comfort command
  commence comment commission commit communicate compare compensate compete compile complain complement complete
  comply compose compound comprehend compress compute conceal concede conceive concentrate conclude condense conduct
  confer configure confine confirm conform confront connect consent conserve consider consolidate construct consult
  consume contact contain contemplate continue contract contrast contribute control convene converse convert convey
  convince cook cool cooperate coordinate cope copy correct correlate correspond cost count couple cover crack craft
  crawl create credit criticize crop cross crush cultivate cure curate customize cut cycle damage dance date deal debate
  debit debrief debug decide declare decline decode decommission decorate decrease decrypt dedicate deduct deem default
  defend defer define delay delegate delete deliberate delight deliver demand demonstrate denote deny depart depend
  depict deploy deposit deprecate derive describe design designate desire destroy detach detail detect determine develop
  devise devote diagnose dial dictate differ differentiate dig digitize dim direct disable disagree disallow disappear
  disapprove disburse discard discharge disclose disconnect discontinue discount discover discuss dismiss dispatch
  dispense display dispose dispute disregard disseminate dissolve distinguish distribute dive divert divide document
  donate double download draft drag drain draw dream dress drift drill drink drive drop dry dump duplicate dust earn
  ease eat echo edit educate effect elaborate elect elevate eliminate email embed embrace emerge emphasize employ empower
  empty emulate enable enact encapsulate enclose encode encourage encrypt end endorse enforce engage engineer enhance
  enjoy enlarge enlist enquire enrol enroll ensure enter entertain enumerate envision equip erase escalate escape
  establish estimate evacuate evaluate evolve examine exceed exchange exclude excuse execute exercise exhibit exist exit
  expand expect expedite expend experience experiment expire explain explore export expose express extend extract
  facilitate factor fail fall familiarize fasten favor favour fax feature feed feel fetch field figure file fill filter
  finalise finalize finance find fine-tune finish fire fit fix flag flatten flip float flow flush fly focus fold follow
  forbid force forecast foresee forget forgive fork form format formulate forward foster frame free freeze fulfil fulfill
  function fund gain gather gauge generate get give glance go govern grab grade graduate grant graph grasp greet grind
  grip group grow guarantee guard guess guide halt hand handle hang happen harden harmonize harness head heal hear heat
  help hide highlight hire hit hold honor honour hook host house hunt hurry hydrate identify ignore illustrate imagine
  impact implement import impose improve improvise include incorporate increase incur indent index indicate induct
  infer influence inform ingest inherit initialize initiate inject inquire insert insist inspect inspire install
  instruct insure integrate intend interact intercept interest interpret interrupt interview introduce invent inventory
  invest investigate invite invoice invoke involve iron isolate issue itemize iterate join journal judge jump justify
  keep key kick kill knock know label land last launch lay lead leak lean learn lease leave lecture lend let level
  leverage license lift light like limit line link list listen live load loan locate lock log look loop lose love lower
  maintain make manage mandate manipulate manufacture map mark market master match mate maximize mean measure mediate
  meet memorize mention mentor merge message migrate mind minimise minimize mirror miss mitigate mix model moderate
  modernize modify monitor motivate mount move multiply mute name narrate narrow navigate need negotiate nest network
  nominate normalize note notice notify number nurture obey object observe obtain occupy occur offer offload omit
  onboard open operate opt optimise optimize orchestrate order organise organize orient outline output outsource
  overcome overlook override oversee overwrite own pack package page paint pair park parse participate partner pass
  paste patch pause pay pend perceive perform permit persist personalize persuade phone photograph pick pilot pin pinpoint
  pitch place plan plant play plead plug point poll populate position post postpone pour practice practise praise
  pray precede predict prefer prefill prepare prescribe present preserve press presume pretend prevent preview price
  print prioritise prioritize probe proceed process procure produce profile program progress prohibit project promise
  promote prompt proofread propagate propose prosecute protect protest prove provide provision publicize publish pull
  pump punch purchase purge pursue push put qualify quantify query question queue quit quote raise rank rate reach
  react read realign realize reallocate reason reassess reassign rebalance rebase reboot rebuild recall receive recognise
  recognize recommend reconcile reconfigure reconnect reconsider record recover recreate recruit rectify recycle redact
  redeem redirect redo reduce refactor refer refine reflect reformat refrain refresh refund refuse regain regard register
  regulate rehearse reimburse reinforce reinstall reiterate reject relate relaunch relax release relocate rely remain
  remark remediate remember remind remove rename render renew rent reorder reorganize repair repeat rephrase replace
  replicate reply report reposition represent reproduce request require reschedule rescue research resend reserve
  reset resize resolve respect respond rest restart restate restore restrict restructure resubmit result resume retain
  retest retire retract retrieve retry return reuse reveal revert review revise revisit revoke reward rewrite ride ring
  rinse rise roll rotate round route run rush sample sanitize satisfy save say scale scan schedule scope score scrape
  screen script scroll scrub seal search secure see seek segment select sell send separate sequence serve service set
  settle setup shape share sharpen shift ship shop shorten show shred shrink shut sign signal simplify simulate sing sit
  size sketch skim skip sleep slice slide slow smile snap solicit solve sort source space speak specify speed spell
  spend split sponsor spot spread squash stabilize stack staff stage stamp stand standardize star start state stay
  steer step stick stimulate stir stop store straighten strategize stream streamline strengthen stress stretch strike
  strip strive structure study style subdivide submit subscribe substitute subtract succeed suggest sum summarise
  summarize supervise supplement supply support suppose suppress surface survey suspend sustain swap sweep switch
  synchronize sync synthesize systematize tabulate tackle tag tailor take talk tap target task teach team tear tell
  template terminate test text thank think thread throttle throw tick tidy tie tighten time timebox tip toggle tolerate
  top total touch tour trace track trade train transcribe transfer transform transition translate transmit transport
  trap travel treat trial triage trigger trim troubleshoot trust try tune turn tweak type uncover undergo underline
  understand undertake undo unfold unify uninstall unite unlock unpack unplug unsubscribe untick update upgrade uphold
  upload urge use utilize vacate validate value vary verify vet view visit visualize voice volunteer vote wait wake
  walk want warn wash watch water wear weigh welcome widen win wipe wire withdraw witness word work worry wrap write
  yield zip zoom
`;

export const ENGLISH_BASE_VERBS: ReadonlySet<string> = new Set(
  VERBS.split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0),
);

/** A base-form verb, allowing the common prefixes ("re-read", "pre-fill", "un-tick", "co-sign", "de-scope", "over-ride"). */
export function isBaseVerb(word: string): boolean {
  const w = word.toLowerCase().replace(/[’']/g, '');
  if (ENGLISH_BASE_VERBS.has(w)) return true;
  const m = /^(?:re|pre|un|co|de|dis|over|under|out|up|mis|cross|double|self|auto)-?(\p{L}{3,})$/u.exec(w);
  return m !== null && ENGLISH_BASE_VERBS.has(m[1]!);
}
