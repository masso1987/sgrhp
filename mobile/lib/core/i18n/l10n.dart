import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:intl/date_symbol_data_local.dart';
import '../storage/secure_store.dart';

/// Lightweight app localization (FR default, EN). A global [appLang] lets any
/// widget call tr('key') without threading a context; changing the language via
/// [localeProvider] rebuilds MaterialApp so the whole tree re-reads translations.
String appLang = 'fr';

const supportedLangs = ['fr', 'en'];

String tr(String key) {
  final m = _S[key];
  if (m == null) return key;
  return m[appLang] ?? m['fr'] ?? key;
}

class LocaleNotifier extends StateNotifier<Locale> {
  LocaleNotifier() : super(Locale(appLang));
  Future<void> set(String lang) async {
    if (!supportedLangs.contains(lang)) return;
    appLang = lang;
    state = Locale(lang);
    try {
      await initializeDateFormatting(lang == 'en' ? 'en_US' : 'fr_FR', null);
      Intl.defaultLocale = lang == 'en' ? 'en_US' : 'fr_FR';
    } catch (_) {}
    try { await SecureStore().setLang(lang); } catch (_) {}
  }
}

final localeProvider = StateNotifierProvider<LocaleNotifier, Locale>((ref) => LocaleNotifier());

/// key -> { fr, en }
const Map<String, Map<String, String>> _S = {
  // nav
  'nav.home': {'fr': 'Accueil', 'en': 'Home'},
  'nav.attendance': {'fr': 'Présence', 'en': 'Attendance'},
  'nav.payslips': {'fr': 'Bulletins', 'en': 'Payslips'},
  'nav.leave': {'fr': 'Congés', 'en': 'Leave'},
  'nav.profile': {'fr': 'Profil', 'en': 'Profile'},
  // common
  'common.retry': {'fr': 'Réessayer', 'en': 'Retry'},
  'common.send': {'fr': 'Envoyer', 'en': 'Send'},
  'common.sync': {'fr': 'Synchroniser', 'en': 'Sync'},
  'common.syncPending': {'fr': 'pointage(s) en attente de synchronisation', 'en': 'punch(es) waiting to sync'},
  'common.cancel': {'fr': 'Annuler', 'en': 'Cancel'},
  'common.save': {'fr': 'Enregistrer', 'en': 'Save'},
  'common.close': {'fr': 'Fermer', 'en': 'Close'},
  'common.done': {'fr': 'Terminé', 'en': 'Done'},
  'common.loading': {'fr': 'Chargement…', 'en': 'Loading…'},
  'common.none': {'fr': 'Aucun', 'en': 'None'},
  'common.search': {'fr': 'Rechercher', 'en': 'Search'},
  'common.optional': {'fr': '(optionnel)', 'en': '(optional)'},
  'common.pending': {'fr': 'En attente', 'en': 'Pending'},
  'common.approved': {'fr': 'Approuvé', 'en': 'Approved'},
  'common.rejected': {'fr': 'Rejeté', 'en': 'Rejected'},
  'common.active': {'fr': 'Actif', 'en': 'Active'},
  // login
  'login.subtitle': {'fr': 'Portail employé — présence & self-service', 'en': 'Employee portal — attendance & self-service'},
  'login.title': {'fr': 'Connexion', 'en': 'Sign in'},
  'login.hint': {'fr': 'Entrez votre matricule et votre mot de passe.', 'en': 'Enter your staff ID and password.'},
  'login.id': {'fr': 'Matricule ou e-mail', 'en': 'Staff ID or email'},
  'login.password': {'fr': 'Mot de passe', 'en': 'Password'},
  'login.submit': {'fr': 'Se connecter', 'en': 'Sign in'},
  'login.forgot': {'fr': 'Mot de passe oublié ?', 'en': 'Forgot password?'},
  'login.server': {'fr': 'Serveur', 'en': 'Server'},
  // dashboard
  'dash.greetMorning': {'fr': 'Bonjour', 'en': 'Good morning'},
  'dash.greetAfternoon': {'fr': 'Bon après-midi', 'en': 'Good afternoon'},
  'dash.greetEvening': {'fr': 'Bonsoir', 'en': 'Good evening'},
  'dash.employee': {'fr': 'Employé', 'en': 'Employee'},
  'dash.todayAttendance': {'fr': 'Présence du jour', 'en': "Today's attendance"},
  'dash.checkedIn': {'fr': 'Pointé', 'en': 'Checked in'},
  'dash.checkedOut': {'fr': 'Sorti', 'en': 'Checked out'},
  'dash.notCheckedIn': {'fr': 'Non pointé', 'en': 'Not checked in'},
  'dash.arrival': {'fr': 'Arrivée', 'en': 'Arrival'},
  'dash.departure': {'fr': 'Départ', 'en': 'Departure'},
  'dash.punchIn': {'fr': "POINTER L'ARRIVÉE", 'en': 'CHECK IN'},
  'dash.punchOut': {'fr': 'POINTER LA SORTIE', 'en': 'CHECK OUT'},
  'dash.leaveBalance': {'fr': 'Solde congés', 'en': 'Leave balance'},
  'dash.lastPayslip': {'fr': 'Dernier bulletin', 'en': 'Last payslip'},
  'dash.shortcuts': {'fr': 'Raccourcis', 'en': 'Shortcuts'},
  'dash.history': {'fr': 'Historique de présence', 'en': 'Attendance history'},
  'dash.requestLeave': {'fr': 'Demander un congé', 'en': 'Request leave'},
  'dash.insurance': {'fr': 'Assurance maladie', 'en': 'Health insurance'},
  'dash.myRequests': {'fr': 'Mes demandes (AVI, acompte)', 'en': 'My requests (AVI, advance)'},
  'dash.surveys': {'fr': 'Enquêtes & évaluations', 'en': 'Surveys & evaluations'},
  'dash.tips': {'fr': 'Astuces RH', 'en': 'HR tips'},
  'dash.myProfile': {'fr': 'Mon profil', 'en': 'My profile'},
  // profile
  'profile.title': {'fr': 'Mon profil', 'en': 'My profile'},
  'profile.company': {'fr': 'Entreprise', 'en': 'Company'},
  'profile.department': {'fr': 'Département', 'en': 'Department'},
  'profile.position': {'fr': 'Poste', 'en': 'Position'},
  'profile.email': {'fr': 'E-mail', 'en': 'Email'},
  'profile.phone': {'fr': 'Téléphone', 'en': 'Phone'},
  'profile.supervisor': {'fr': 'Superviseur', 'en': 'Supervisor'},
  'profile.language': {'fr': 'Langue', 'en': 'Language'},
  'profile.logout': {'fr': 'Se déconnecter', 'en': 'Sign out'},
  // payslips
  'pay.title': {'fr': 'Bulletins de paie', 'en': 'Payslips'},
  'pay.empty': {'fr': 'Aucun bulletin disponible', 'en': 'No payslip available'},
  'pay.emptySub': {'fr': 'Vos bulletins apparaîtront ici une fois la paie clôturée.', 'en': 'Your payslips appear here once payroll is closed.'},
  'pay.net': {'fr': 'Net', 'en': 'Net'},
  // leave
  'leave.title': {'fr': 'Congés', 'en': 'Leave'},
  'leave.balance': {'fr': 'Solde', 'en': 'Balance'},
  'leave.accrued': {'fr': 'acquis', 'en': 'accrued'},
  'leave.taken': {'fr': 'pris', 'en': 'taken'},
  // maintenance
  'maint.title': {'fr': 'Application en maintenance', 'en': 'App under maintenance'},
  'maint.body': {'fr': "Nous effectuons une maintenance technique. L'application sera de nouveau disponible sous peu. Merci de votre patience.", 'en': 'We are performing technical maintenance. The app will be available again shortly. Thank you for your patience.'},
  'maint.back': {'fr': 'Retour prévu le', 'en': 'Expected back on'},
  'maint.again': {'fr': 'Vérifier à nouveau', 'en': 'Check again'},
  'maint.planned': {'fr': 'Maintenance planifiée le', 'en': 'Maintenance scheduled for'},
  'maint.plannedSoon': {'fr': 'Maintenance planifiée prochainement', 'en': 'Maintenance scheduled soon'},
};
