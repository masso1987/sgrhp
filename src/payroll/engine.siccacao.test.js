/* Validation SIC CACAO (CIBLE RH MISE A DISPOSITION SIC CACAO), Sage, août 2026.
 * Config INDUSTRIE AGROALIMENTAIRE (distincte des autres clients).
 *   - Non cotisables (hors CNPS/AT) : transport(3513), forfait H.S.(1080), nourriture(3511),
 *     salissure(3010), prime risque(2103), + primes/indemnités 2143,2130,3506,3512,3515,3520.
 *     PVID plafonnée 750 000 ; AT non plafonnée.
 *   - Non imposables : 1080,3010,2103,2130,2117,3512,3515,3520. Logement(3510) plafonné 15%.
 *     Nourriture, transport, 3506, 2143, heures sup(1083/1088/1092/1096) imposables.
 *   - Base CFC = taxable arrondi au millier inférieur.
 *
 * 15 bulletins représentatifs (données exactes extraites des bulletins Sage), reproduits
 * au franc : BRUT, base CNPS, salaire taxable, base CFC. Couvre PVID plafonnée (114336),
 * logement écrêté, 2117/2143/2128/3506/3512/3515 et heures sup. */
const { computePayslip } = require("./engine");

const SIC = {
  transportExemptionCap: 0,
  avantagesNatureList: [{ rubriqueCode: "3510", rate: 0.15, active: true }],
};

const EMP = [
  { n:"114806", b:99408, t:15721, gains:[{code:"1030",label:"Surs",amount:12002,cnps:true,impo:true}, {code:"1080",label:"ForfHS",amount:20000,cnps:false,impo:false}, {code:"1083",label:"HS125",amount:12904,cnps:true,impo:true}, {code:"3510",label:"Log",amount:17389,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:12000,cnps:false,impo:true}], r:{brut:189424, pvid:141703, ni:169424, cfc:169000} },
  { n:"1140453", b:204606, t:35000, gains:[{code:"1030",label:"Surs",amount:100743,cnps:true,impo:true}, {code:"1080",label:"ForfHS",amount:30000,cnps:false,impo:false}, {code:"2103",label:"Risq",amount:15000,cnps:false,impo:false}, {code:"3010",label:"Sal",amount:30000,cnps:false,impo:false}, {code:"3510",label:"Log",amount:35000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:16000,cnps:false,impo:true}], r:{brut:466349, pvid:340349, ni:391349, cfc:391000} },
  { n:"114732", b:184488, t:45000, gains:[{code:"1030",label:"Surs",amount:27000,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:25000,cnps:false,impo:false}, {code:"3506",label:"Ind",amount:108013,cnps:false,impo:true}, {code:"3510",label:"Log",amount:35000,cnps:true,impo:true}, {code:"3515",label:"Av",amount:21150,cnps:false,impo:false}], r:{brut:445651, pvid:246488, ni:399501, cfc:399000} },
  { n:"1140420", b:279603, t:0, gains:[{code:"1030",label:"Surs",amount:58009,cnps:true,impo:true}, {code:"1083",label:"HS125",amount:211723,cnps:true,impo:true}, {code:"1088",label:"HS30",amount:37747,cnps:true,impo:true}, {code:"1092",label:"HS40",amount:11292,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:24197,cnps:true,impo:true}, {code:"3510",label:"Log",amount:73779,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:8000,cnps:false,impo:true}, {code:"3515",label:"Av",amount:100000,cnps:false,impo:false}], r:{brut:804350, pvid:696350, ni:704350, cfc:704000} },
  { n:"114860", b:68986, t:24175, gains:[{code:"1083",label:"HS125",amount:4117,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:9670,cnps:false,impo:false}, {code:"3510",label:"Log",amount:23974,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:6000,cnps:false,impo:true}], r:{brut:136922, pvid:97077, ni:118770, cfc:118000} },
  { n:"114690", b:41599, t:9990, gains:[{code:"1080",label:"ForfHS",amount:6660,cnps:false,impo:false}, {code:"2103",label:"Risq",amount:4995,cnps:false,impo:false}, {code:"2117",label:"Ind",amount:16000,cnps:true,impo:false}, {code:"3510",label:"Log",amount:30000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:6000,cnps:false,impo:true}], r:{brut:115244, pvid:87599, ni:66227, cfc:66000} },
  { n:"114691", b:124796, t:30000, gains:[{code:"1080",label:"ForfHS",amount:20000,cnps:false,impo:false}, {code:"1083",label:"HS125",amount:7200,cnps:true,impo:true}, {code:"1088",label:"HS30",amount:7488,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:8640,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:15000,cnps:false,impo:false}, {code:"2117",label:"Ind",amount:28000,cnps:true,impo:false}, {code:"3510",label:"Log",amount:30000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:12000,cnps:false,impo:true}], r:{brut:283124, pvid:206124, ni:218643, cfc:218000} },
  { n:"114336", b:222413, t:0, gains:[{code:"1030",label:"Surs",amount:271331,cnps:true,impo:true}, {code:"1083",label:"HS125",amount:51327,cnps:true,impo:true}, {code:"1088",label:"HS30",amount:40035,cnps:true,impo:true}, {code:"1092",label:"HS40",amount:17156,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:15398,cnps:true,impo:true}, {code:"2128",label:"Resp",amount:50000,cnps:true,impo:true}, {code:"2143",label:"Prime",amount:5000,cnps:false,impo:true}, {code:"3510",label:"Log",amount:100000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:10000,cnps:false,impo:true}, {code:"3512",label:"Av",amount:100000,cnps:false,impo:false}, {code:"3515",label:"Av",amount:100000,cnps:false,impo:false}], r:{brut:982660, pvid:750000, ni:782660, cfc:782000} },
  { n:"114861", b:127454, t:33000, gains:[{code:"1080",label:"ForfHS",amount:46261,cnps:false,impo:false}, {code:"1083",label:"HS125",amount:7353,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:8824,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:20000,cnps:false,impo:false}, {code:"2117",label:"Ind",amount:60000,cnps:true,impo:false}, {code:"2143",label:"Prime",amount:20000,cnps:false,impo:true}, {code:"3510",label:"Log",amount:35000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:12000,cnps:false,impo:true}], r:{brut:369892, pvid:238631, ni:239926, cfc:239000} },
  { n:"114782", b:222413, t:0, gains:[{code:"1083",label:"HS125",amount:27187,cnps:true,impo:true}, {code:"1092",label:"HS40",amount:12575,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:42345,cnps:true,impo:true}, {code:"2143",label:"Prime",amount:5000,cnps:false,impo:true}, {code:"3510",label:"Log",amount:73779,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:4000,cnps:false,impo:true}, {code:"3515",label:"Av",amount:100000,cnps:false,impo:false}], r:{brut:487299, pvid:378299, ni:360548, cfc:360000} },
  { n:"11413", b:124796, t:30000, gains:[{code:"1080",label:"ForfHS",amount:20000,cnps:false,impo:false}, {code:"1096",label:"HSnuit",amount:1080,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:20000,cnps:false,impo:false}, {code:"2117",label:"Ind",amount:14000,cnps:true,impo:false}, {code:"3510",label:"Log",amount:30000,cnps:true,impo:true}], r:{brut:239876, pvid:169876, ni:179257, cfc:179000} },
  { n:"1140451", b:99408, t:15721, gains:[{code:"1030",label:"Surs",amount:12159,cnps:true,impo:true}, {code:"1082",label:"Prime",amount:20000,cnps:true,impo:true}, {code:"1083",label:"HS125",amount:11470,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:6882,cnps:true,impo:true}, {code:"2143",label:"Prime",amount:5000,cnps:false,impo:true}, {code:"3510",label:"Log",amount:17389,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:8000,cnps:false,impo:true}], r:{brut:196029, pvid:167308, ni:196029, cfc:196000} },
  { n:"114704", b:127454, t:35000, gains:[{code:"1083",label:"HS125",amount:5055,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:8824,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:20000,cnps:false,impo:false}, {code:"2143",label:"Prime",amount:5000,cnps:false,impo:true}, {code:"3010",label:"Sal",amount:46261,cnps:false,impo:false}, {code:"3510",label:"Log",amount:33000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:20000,cnps:false,impo:true}], r:{brut:300594, pvid:174333, ni:231533, cfc:231000} },
  { n:"114789", b:124796, t:30000, gains:[{code:"1080",label:"ForfHS",amount:20000,cnps:false,impo:false}, {code:"1083",label:"HS125",amount:7200,cnps:true,impo:true}, {code:"1088",label:"HS30",amount:7488,cnps:true,impo:true}, {code:"1092",label:"HS40",amount:16128,cnps:true,impo:true}, {code:"1096",label:"HSnuit",amount:8640,cnps:true,impo:true}, {code:"2103",label:"Risq",amount:15000,cnps:false,impo:false}, {code:"2117",label:"Ind",amount:20000,cnps:true,impo:false}, {code:"2143",label:"Prime",amount:5000,cnps:false,impo:true}, {code:"3010",label:"Sal",amount:10000,cnps:false,impo:false}, {code:"3510",label:"Log",amount:30000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:12000,cnps:false,impo:true}], r:{brut:306252, pvid:214252, ni:241252, cfc:241000} },
  { n:"1140322", b:184488, t:33000, gains:[{code:"1030",label:"Surs",amount:52594,cnps:true,impo:true}, {code:"1080",label:"ForfHS",amount:50000,cnps:false,impo:false}, {code:"1083",label:"HS125",amount:23948,cnps:true,impo:true}, {code:"3510",label:"Log",amount:35000,cnps:true,impo:true}, {code:"3511",label:"Nourr",amount:6000,cnps:false,impo:true}], r:{brut:385030, pvid:296030, ni:335030, cfc:335000} },
];

let pass = 0, fail = 0;
const chk = (n, got, exp) => { const ok = got === exp; console.log(`${ok ? "✓" : "✗"} ${n}: ${got} (Sage ${exp})`); ok ? pass++ : fail++; };

for (const e of EMP) {
  const transport = { code: "3513", label: "Transport", amount: e.t };
  const r = computePayslip({ baseSalary: e.b, workedDays: 30, standardDays: 30, seniorityYears: 0,
    gains: e.gains, nonTaxable: [], transport, ravBase: e.r.brut, tdlBase: e.b }, SIC);
  const t = r.totals;
  chk(`${e.n} BRUT`, t.brutTotal, e.r.brut);
  chk(`${e.n} base CNPS`, r.meta.cnpsBase, e.r.pvid);
  chk(`${e.n} salaire taxable`, t.netImposable, e.r.ni);
  chk(`${e.n} base CFC`, t.baseCF, e.r.cfc);
}
console.log(`\n=== SIC CACAO : ${pass} passed, ${fail} failed (BRUT / base CNPS / salaire taxable / base CFC, au franc) ===`);
process.exit(fail ? 1 : 0);
