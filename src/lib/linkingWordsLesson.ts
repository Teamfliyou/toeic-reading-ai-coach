// Leçon « Linking words — Les mots de liaison ».
import type { FillItem, McqItem } from "./wordFormLesson";

export type LinkSection = { title: string; rows: [string, string, string][] };

export const LINK_SECTIONS: LinkSection[] = [
  { title: "1. Précision", rows: [
    ["insofar as", "dans la mesure où, en ce sens que", "I believe in God insofar as I feel sure there is a power guiding the universe."],
    ["i.e. (id est) / that is to say", "c'est-à-dire", "Keeping a dog will cost you a lot of money, i.e. £200."],
    ["namely", "à savoir", "I'm thinking of three U.S. presidents, namely Roosevelt, Eisenhower and Kennedy."],
    ["e.g. (exempli gratia) / for example", "par exemple", "Many US fast-food chains (e.g. Pizza Hut) are well established in Europe."],
  ] },
  { title: "2. But", rows: [
    ["in order that", "afin que", "In order that you can complete your task, we have installed 24-hour surveillance."],
    ["(in order) to", "afin de", "This is what we must do (in order) to help them."],
    ["in such a way as to", "de telle façon à", "We have organised things in such a way as to make sure that nobody loses."],
    ["so as to", "afin de", "They went ahead on foot so as not to be heard."],
    ["by way of", "en guise de", "By way of introduction, let me tell you something about my recent experiences in Borneo."],
    ["so that", "de sorte que, afin que", "He needs to earn a good salary so that he can keep paying his bills."],
  ] },
  { title: "3. Résultat", rows: [
    ["as a result", "par conséquent", "As a result of your incompetence, the whole switchboard has now been destroyed."],
    ["consequently", "par conséquent", "We spent most of the money in the first quarter and consequently had none left in the final one."],
    ["so", "ainsi, donc", "This is very easy so I expect you to finish before 4 o'clock."],
    ["then", "puis", "Do this first, then come and see me."],
    ["therefore", "par conséquent, donc", "The new car is smaller and therefore cheaper than our old one."],
    ["thus", "ainsi, donc", "A rise in income will increase purchasing power, thus stimulating the economy."],
    ["hence", "d'où", "His mother was Italian, hence the name Giulio."],
    ["accordingly", "en conséquence", "When we receive your instructions, we shall act accordingly."],
  ] },
  { title: "4. Exemple", rows: [
    ["e.g. / for example", "par exemple", "Many companies have used our services, e.g. Renault, Cisco, Nokia."],
    ["such as", "comme, tel que", "Brands such as Nike and Adidas are the essence of fashionable sportswear."],
    ["for instance", "par exemple", "Take your mother for instance."],
  ] },
  { title: "5. Généralités", rows: [
    ["usually", "d'habitude", "I usually play badminton on Sunday afternoon."],
    ["for the most part", "pour la plupart", "The factory operatives are, for the most part, hard-working, honest people."],
    ["on the whole", "en gros, dans l'ensemble", "There were a few problems, but on the whole, the event went very well."],
    ["as a rule", "en règle générale", "As a rule, we disbelieve all the facts and theories that are of no use to us."],
  ] },
  { title: "6. Identification", rows: [
    ["in the case of", "dans le cas de", "In the case of young Harry though, we will have to make an exception."],
    ["as for", "quant à", "As for the meeting, it will have to be cancelled."],
    ["elsewhere", "ailleurs", "We still have problems here, but elsewhere everything is under control."],
    ["wherever", "partout où", "Wherever you look these days, there is a McDonald's and a Starbucks."],
  ] },
  { title: "7. Temps", rows: [
    ["prior to", "préalablement à", "Prior to signing the agreement, we must read the small print."],
    ["once", "une fois que", "Once you have finished your test, you may leave the room."],
    ["since", "depuis (point de départ)", "It has been this way since 1947."],
    ["for", "depuis, pendant (durée)", "It has been this way for 80 years."],
    ["for the time being", "pour l'instant", "For the time being we will have to continue with the old method."],
    ["until / till", "jusqu'à ce que", "They didn't find her until the following day."],
    ["whenever", "chaque fois que", "Whenever I hear the word 'culture' I reach for my revolver."],
    ["while", "pendant que", "It happened while I was out of the room."],
  ] },
  { title: "8. Comparaison", rows: [
    ["in comparison (with)", "en comparaison (avec)", "In comparison with some companies, ours isn't too bad at all."],
    ["similarly", "de même, parallèlement", "Cars have to stop at red lights; similarly, bicycles should also stop."],
    ["likewise", "également, de même", "He had a very hostile attitude towards the police; likewise to his parents."],
  ] },
  { title: "9. Degré", rows: [
    ["in many ways", "à bien des égards", "She seemed like the perfect partner, and in many ways she was."],
    ["in some respects", "à certains égards", "He was like his father in some respects; in others he was totally different."],
    ["one way or another", "d'une façon ou d'une autre", "I will have my revenge on him one way or another."],
    ["to some extent", "dans une certaine mesure", "We can recuperate our losses to some extent by selling what we don't need."],
    ["to a large extent", "en grande partie", "Life will always be to a large extent what we make of it."],
    ["thus", "ainsi, donc", "A rise in income will increase purchasing power, thus stimulating the economy."],
    ["somehow", "d'une certaine façon, d'une façon ou d'une autre", "You look somehow different. / We must finish the job by tomorrow evening somehow."],
  ] },
];

const f = (before: string, after: string, ...answers: string[]): FillItem => ({ before, after, answers });

// Exercice 1 : une phrase par question. Corrections rédigées pour l'application (plusieurs réponses acceptées).
export const FILL_1: FillItem[] = [
  f("There's no coffee. Will you have some tea", "?", "instead"),
  f("He's too fat and has no hair, and", "he is somehow very attractive.", "yet", "still", "nevertheless", "nonetheless", "even so"),
  f("", "the terrible weather, the event attracted a big crowd.", "despite", "in spite of"),
  f("We can recuperate our losses to some", "by selling what we don't need.", "extent"),
  f("I'm thinking of three U.S. presidents,", ": Roosevelt, Eisenhower and Kennedy.", "namely"),
  f("A rise in income will increase purchasing power,", "stimulating the economy.", "thus"),
  f("", "to signing the agreement, we must read the small print.", "prior"),
  f("It happened", "I was out of the room.", "while"),
  f("For the time", "we will have to continue with the old method.", "being"),
  f("“", "I hear the word 'culture' I reach for my revolver” (H. Goering).", "whenever"),
  f("", "you have finished your test, you may leave the room.", "once"),
  f("It has been this way", "80 years.", "for"),
  f("They went ahead on foot so", "not to be heard.", "as"),
  f("He was like his father in some", "; in others he was totally different.", "respects"),
  f("He had a very hostile attitude towards the police;", "to his parents.", "likewise", "similarly"),
  f("He'll come with us", "he can bring his dog with him.", "provided", "providing", "provided that", "providing that", "as long as", "so long as", "on condition that", "if"),
  f("I don't know", "to laugh or cry.", "whether"),
  f("I'd better write it down,", "I'll forget it.", "otherwise", "or else"),
  f("I already knew most of the points she made, but her talk was interesting", ".", "nevertheless", "nonetheless", "anyway", "all the same", "even so", "still", "though", "however"),
  f("", "me, you will be travelling by train. I'm going to take the car.", "as for", "unlike"),
];

export const FILL_2: FillItem[] = [
  f("You should learn the vocabulary", "you will have trouble in the test next week.", "otherwise", "or else"),
  f("The passengers received", "food nor drink during the flight.", "neither"),
  f("", "of typing out all the text, why don't you just photocopy it.", "instead"),
  f("The train has been delayed", "to snow on the tracks.", "due", "owing"),
  f("There is a difference in Berlin", "the one in Frankfurt.", "compared to", "compared with", "in comparison with", "in comparison to", "as opposed to"),
  f("In the morning I drink coffee,", "in the evening I drink herbal tea.", "whereas", "while"),
  f("Our opponents have won their last four matches,", "we feel confident of a win tomorrow.", "but", "yet", "still", "nevertheless", "nonetheless", "however", "even so"),
  f("", "the number of people eating at the canteen is increasing, the management has decided to hire a new chef and two part time counter staff.", "as", "since", "because", "given that", "seeing that"),
  f("Our prices are relatively low", "our competitors, which means we should sell more products.", "compared to", "compared with", "in comparison with", "in comparison to"),
  f("We are laying off staff", "the increase in profits this year.", "despite", "in spite of", "notwithstanding"),
];

export const LINK_MCQ: McqItem[] = [
  { prompt: "He is not our best worker. ________, he has done a good job today.", options: ["In spite of", "As well as", "Nevertheless", "Namely"], answer: "Nevertheless", why: "Deux idées qui s'opposent, séparées par un point : « Nevertheless » (pourtant). « In spite of » doit être suivi d'un nom ou d'un gérondif." },
  { prompt: "________ all your papers in order, we will send off the application form.", options: ["Provided", "Or", "Whereas", "Instead of"], answer: "Provided", why: "Condition : « Provided (that) » = à condition que." },
  { prompt: "He has failed many times, ________ he never gives up.", options: ["on the one hand", "or", "yet", "furthermore"], answer: "yet", why: "Opposition entre deux propositions : « yet » (pourtant)." },
  { prompt: "________ repeated warnings, the client has still not paid the bill.", options: ["Namely", "Similarly", "Although", "Despite"], answer: "Despite", why: "Suivi d'un groupe nominal (« repeated warnings ») : « Despite ». « Although » exigerait un sujet et un verbe." },
  { prompt: "You can borrow my car ________ I get it back before 5 o'clock.", options: ["namely", "somehow", "as long as", "otherwise"], answer: "as long as", why: "Condition : « as long as » = pourvu que, tant que." },
  { prompt: "Post the letter today, ________ it will be too late.", options: ["otherwise", "while", "besides", "unless"], answer: "otherwise", why: "« Otherwise » = sinon (conséquence si on ne le fait pas)." },
];
