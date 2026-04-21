
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Chart, User, Screen, LayoutDetails, GeneratedRowsLayout, Desk, RowsLayoutDetails, UnplacedStudentInfo, Student, GeneratedLayout, Class, UserProfile, Notification as AppNotification } from './types';
import { loadUserProfile, saveUserCharts, loadUserCharts, updateUserAdminFields, handleFirestoreError, OperationType, loadChartById, deleteChart, deleteChartsBatch } from './services/storageService';
import { generateLayout } from './services/layoutService';
import { auth, db, createUserProfile } from './services/firebase';
import { trackLogin, getUserProfile } from './services/firebase';
import { onAuthStateChanged, signOut } from "firebase/auth";
import { onSnapshot, doc, getDocFromCache, getDocFromServer, collection, query, where, updateDoc, getDocs } from "firebase/firestore";
import LoginScreen from './components/screens/LoginScreen';
import MainScreen from './components/screens/MainScreen';
import EditorScreen from './components/screens/EditorScreen';
import ResultScreen from './components/screens/ResultScreen';
import AdminPanel from './components/screens/AdminPanel';
import OnboardingModal from './components/OnboardingModal';
import NotificationBell from './components/NotificationBell';
import { generateId } from './utils';
import { DEFAULT_ROWS_LAYOUT, DEFAULT_GROUPS_LAYOUT, DEFAULT_STUDENT_CONSTRAINTS } from './constants';
import EditorHeader from './components/layout/EditorHeader';
import ConfirmActionModal from './components/modals/ConfirmActionModal';
import { Toaster, toast } from 'sonner';
import { FirestoreQuotaError } from './services/storageService';
import { AlertTriangle } from 'lucide-react';

const ADMIN_EMAIL = "lirondavid3@gmail.com";
const checkIfUserAllowed = async (email: string): Promise<boolean> => {
    const q = query(collection(db, "allowedUsers"), where("email", "==", email.toLowerCase()));
    const snapshot = await getDocs(q);
console.log("checkIfUserAllowed result:", snapshot.empty, "for email:", email);
return !snapshot.empty;
};
const MainHeader: React.FC<{ 
    user: User | null; 
    profile: UserProfile | null;
    onLogout: () => void; 
    onGoToAdmin: () => void;
    onReadNotification: (id: string) => void;
    onDeleteNotification: (id: string) => void;
    onClearAllNotifications: () => void;
    onActionNotification: (notification: AppNotification) => void;
}> = ({ user, profile, onLogout, onGoToAdmin, onReadNotification, onDeleteNotification, onClearAllNotifications, onActionNotification }) => (
    <header className="bg-white/80 backdrop-blur-sm shadow-sm p-4 flex justify-between items-center print-hidden">
        <div className="flex items-center gap-3">
            {user?.picture && (
                <img src={user.picture} alt={user.name} className="h-12 w-12 rounded-full border border-slate-200" />
            )}
            <div>
                <h1 className="text-lg md:text-xl font-bold text-slate-800 leading-tight">
                    מפות ישיבה<br />
                    וחלוקה לקבוצות
                </h1>
                <div className="flex items-center gap-2">
                    <p className="text-[10px] md:text-xs text-slate-500">מחובר/ת כ: {profile?.firstName ? `${profile.firstName} ${profile.lastName}` : user?.name}</p>
                    {profile?.subscriptionPlan && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                            profile.subscriptionPlan === 'pro' ? 'bg-amber-100 text-amber-700 border border-amber-200' : 
                            profile.subscriptionPlan === 'enterprise' ? 'bg-purple-100 text-purple-700 border border-purple-200' : 
                            'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}>
                            {profile.subscriptionPlan === 'pro' ? 'PRO' : profile.subscriptionPlan === 'enterprise' ? 'ENTERPRISE' : 'FREE'}
                        </span>
                    )}
                </div>
            </div>
        </div>
        <div className="flex items-center gap-3">
            {profile && (
                <NotificationBell 
                    notifications={profile.notifications || []} 
                    onRead={onReadNotification}
                    onDelete={onDeleteNotification}
                    onClearAll={onClearAllNotifications}
                    onAction={onActionNotification}
                />
            )}
            {(user?.role === 'admin' || user?.email === ADMIN_EMAIL) && (
                <button 
                    onClick={onGoToAdmin}
                    className="text-sm bg-teal-100 text-teal-700 py-2 px-4 rounded-lg border border-teal-200 hover:bg-teal-200 font-bold transition-all active:scale-95"
                >
                    ניהול
                </button>
            )}
            <button 
                onClick={onLogout} 
                className="text-sm bg-slate-500 text-white py-2 px-4 rounded-lg hover:bg-slate-600 transition-all active:scale-95"
            >
                יציאה
            </button>
        </div>
    </header>
);

const App: React.FC = () => {
    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [allCharts, setAllCharts] = useState<{ [email: string]: Chart[] }>({});
    const [currentScreen, setCurrentScreen] = useState<Screen>('login');
    const [editingChart, setEditingChart] = useState<Chart | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(true); 
    const [isChartDirty, setIsChartDirty] = useState<boolean>(false);
    const [showBackConfirm, setShowBackConfirm] = useState(false);
    const [quotaExceeded, setQuotaExceeded] = useState<boolean>(false);
    const [showOnboarding, setShowOnboarding] = useState<boolean>(false);
    
    // Refs for debounced saving and loop prevention
    const lastSavedChartsRef = useRef<string>('');
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isInitialLoadRef = useRef<boolean>(true);
    
    // Editor specific states
    const [groupingMethod, setGroupingMethod] = useState('random');

    // --- FIREBASE AUTH INTEGRATION ---
    useEffect(() => {
        // Test connection to Firestore
        const testConnection = async () => {
            if (!db) return;
            try {
                await getDocFromServer(doc(db, 'test', 'connection'));
            } catch (error) {
                if (error instanceof Error && error.message.includes('the client is offline')) {
                    console.error("Please check your Firebase configuration. The client is offline.");
                }
                // Skip logging for other errors, as this is simply a connection test.
            }
        };
        testConnection();

        const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
            if (firebaseUser && firebaseUser.email) {
                setIsLoading(true);
                try {
                    // Load initial profile data
                    let profileData = await loadUserProfile(firebaseUser.uid);
                    if (firebaseUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
                        const isAllowed = await checkIfUserAllowed(firebaseUser.email);
                        if (!isAllowed) {
                            await signOut(auth);
                            toast.error("אין לך הרשאה להיכנס למערכת. פנה למנהל.");
                            setIsLoading(false);
                            return;
                        }
                    }
                    // SELF-REPAIR: If super admin profile is missing, create it automatically
                    if (!profileData && firebaseUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
                        console.log("Self-repairing super admin profile...");
                        const now = new Date().toISOString();
                        const newProfile: UserProfile = {
                            uid: firebaseUser.uid,
                            email: firebaseUser.email.toLowerCase(),
                            firstName: "לירון",
                            lastName: "דוד",
                            schoolName: "ניהול מערכת",
                            location: "",
                            subjects: [],
                            classes: [],
                            role: 'admin',
                            isFrozen: false,
                            subscriptionPlan: 'pro',
                            subscriptionExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
                            stats: {
                                firstLogin: now,
                                lastLogin: now,
                                loginCount: 1,
                                loginHistory: [now]
                            },
                            shareHistory: [],
                            notifications: []
                        };
                        await createUserProfile(newProfile);
                        profileData = newProfile;
                        toast.success("פרופיל מנהל שוחזר בהצלחה");
                    }
                    
                    const user: User = {
                        uid: firebaseUser.uid,
                        email: firebaseUser.email,
                        name: firebaseUser.displayName || firebaseUser.email.split('@')[0],
                        picture: firebaseUser.photoURL || null,
                        role: profileData?.role || (firebaseUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'user'),
                        isFrozen: profileData?.isFrozen || false
                    };
                    
                    setCurrentUser(user);

                    if (profileData) {
                        if (profileData.firstName) {
                            // Track login analytics
                            await trackLogin(firebaseUser.uid);
                            setCurrentScreen('main');
                        } else {
                            setShowOnboarding(true);
                        }
                    } else {
                        // New user, definitely needs onboarding
                        setShowOnboarding(true);
                    }
                } catch (e: any) {
                    console.error("Error in auth state change handler:", e);
                    if (e instanceof FirestoreQuotaError) {
                        setQuotaExceeded(true);
                        toast.error("מכסת השימוש בבסיס הנתונים הסתיימה להיום. הנתונים יישמרו מקומית בדפדפן.");
                    } else {
                        const errorMsg = e.message || String(e);
                        if (errorMsg.includes('network-request-failed') || errorMsg.includes('unavailable')) {
                            toast.error("שגיאת תקשורת בטעינת הפרופיל. נסה לרענן את הדף.");
                        }
                    }
                } finally {
                    setIsLoading(false);
                    isInitialLoadRef.current = false;
                }
            } else {
                console.log("No user authenticated. Setting screen to login.");
                setCurrentUser(null);
                setUserProfile(null);
                setCurrentScreen('login');
                setAllCharts({});
                setIsLoading(false);
            }
        });

        return () => {
            unsubscribeAuth();
        };
    }, []);

    // Real-time profile and charts listener
    useEffect(() => {
        if (!currentUser || !auth.currentUser) return;

        const uid = auth.currentUser.uid;

        // Listen to profile
        const unsubscribeProfile = onSnapshot(doc(db, "users", uid), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data() as UserProfile;
                setUserProfile(data);
                
                // Check if onboarding is needed
                if (!data.firstName) {
                    setShowOnboarding(true);
                }

                setCurrentUser(prev => {
                    if (!prev) return null;
                    if (prev.role === data.role && prev.isFrozen === data.isFrozen) {
                        return prev;
                    }
                    return {
                        ...prev,
                        role: data.role || prev.role,
                        isFrozen: !!data.isFrozen
                    };
                });
            }
        }, (error) => {
            handleFirestoreError(error, OperationType.GET, `users/${uid}`);
        });

        // Listen to own charts
        const qOwn = query(collection(db, "charts"), where("ownerId", "==", uid));
        const unsubscribeOwn = onSnapshot(qOwn, (snapshot) => {
            const charts: Chart[] = [];
            snapshot.forEach((doc) => {
                charts.push({ id: doc.id, ...doc.data() } as Chart);
            });
            
            const chartsStr = JSON.stringify(charts);
            // Always update state if the string representation changed from what we have in state
            setAllCharts(prev => {
                const currentEmail = currentUser.email!;
                const prevChartsStr = JSON.stringify(prev[currentEmail] || []);
                if (chartsStr === prevChartsStr) return prev;
                
                // Update the ref to prevent the auto-save effect from firing immediately back
                lastSavedChartsRef.current = chartsStr;
                return { ...prev, [currentEmail]: charts };
            });
        });

        return () => {
            unsubscribeProfile();
            unsubscribeOwn();
        };
    }, [currentUser?.email]);

    // Persist data effect with debouncing and loop prevention
    useEffect(() => {
        if (isLoading || isInitialLoadRef.current || !currentUser?.email) return;
        
        const userCharts = allCharts[currentUser.email];
        if (!userCharts) return;

        const currentChartsStr = JSON.stringify(userCharts);
        
        // If data hasn't changed since last save/load, don't trigger save
        if (currentChartsStr === lastSavedChartsRef.current) return;

        // Clear existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Debounce save for 3 seconds
        saveTimeoutRef.current = setTimeout(async () => {
            try {
                // Update ref BEFORE saving to prevent race conditions with onSnapshot
                lastSavedChartsRef.current = currentChartsStr;
                
                if (auth.currentUser) {
                    await saveUserCharts(
                        auth.currentUser.uid, 
                        userCharts
                    );
                }
                setQuotaExceeded(false);
            } catch (err) {
                if (err instanceof FirestoreQuotaError) {
                    setQuotaExceeded(true);
                    toast.error("מכסת השמירה הסתיימה. הנתונים נשמרים זמנית בדפדפן.");
                }
                console.error("Auto-save failed", err);
            }
        }, 3000);

        return () => {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        };
    }, [allCharts, currentUser?.email, isLoading]);

    const handleLogout = async () => {
        try {
            await signOut(auth);
            setEditingChart(null);
            setCurrentUser(null);
            setUserProfile(null);
            setShowOnboarding(false);
            setCurrentScreen('login');
        } catch (err) {
            console.error("Logout failed", err);
        }
    };

    const handleSetEditingChart = (updater: React.SetStateAction<Chart | null>) => {
        setEditingChart(prevChart => {
            const newChart = typeof updater === 'function' ? updater(prevChart) : updater;
            // Simple reference check is enough for most cases, 
            // and much faster than JSON.stringify for large charts.
            if (newChart !== prevChart) {
                setIsChartDirty(true);
            }
            return newChart;
        });
    };

    const handleSaveCurrentChart = useCallback(async () => {
        if (editingChart && currentUser && auth.currentUser) {
            // Finalize the chart before saving
            const chartToSave = { ...editingChart };
            if (chartToSave.layoutHistory && typeof chartToSave.activeLayoutIndex === 'number') {
                chartToSave.generatedLayout = chartToSave.layoutHistory[chartToSave.activeLayoutIndex];
            }
            // Clean up temporary versioning state
            delete chartToSave.layoutHistory;
            delete chartToSave.activeLayoutIndex;

            // Update local state and ref
            setAllCharts(prevAllCharts => {
                const charts = prevAllCharts[currentUser.email] || [];
                const existingIndex = charts.findIndex(c => c.id === chartToSave.id);
                let newCharts;
                if (existingIndex > -1) {
                    newCharts = charts.map((c, index) => index === existingIndex ? chartToSave : c);
                } else {
                    newCharts = [...charts, chartToSave];
                }
                
                // Update ref to prevent auto-save from firing again for this exact state
                lastSavedChartsRef.current = JSON.stringify(newCharts);
                
                return { ...prevAllCharts, [currentUser.email]: newCharts };
            });

            // Persist to Firestore immediately
            try {
                await saveUserCharts(auth.currentUser.uid, [chartToSave]);
                setIsChartDirty(false);
                toast.success(editingChart.layoutType === 'groups' ? "הקבוצה נשמרה בהצלחה!" : "המפה נשמרה בהצלחה!");
            } catch (err) {
                console.error("Manual save failed", err);
                toast.error("שגיאה בשמירה לשרת");
            }
        }
    }, [editingChart, currentUser]);

    const handleSaveAndExit = async () => {
        await handleSaveCurrentChart();
        setEditingChart(null);
        setCurrentScreen('main');
    };

    const handleBackToMain = () => {
        if (isChartDirty) {
            setShowBackConfirm(true);
        } else {
            setEditingChart(null);
            setCurrentScreen('main');
        }
    };

    const handleStartNewChart = (className: string, date: string, layoutType: 'rows' | 'groups') => {
        if (currentUser && auth.currentUser) {
            const newChart: Chart = {
                id: generateId(),
                className,
                creationDate: date,
                layoutType,
                layoutDetails: layoutType === 'rows' ? { ...DEFAULT_ROWS_LAYOUT } : { ...DEFAULT_GROUPS_LAYOUT },
                students: [],
                generatedLayout: null,
                constraints: [],
                ownerId: auth.currentUser.uid,
                ownerName: userProfile ? `${userProfile.firstName} ${userProfile.lastName}` : (currentUser.name || 'מורה'),
                ownerSchool: userProfile?.schoolName || '',
                sharedWith: [],
                sharedWithEmails: []
            };

            setAllCharts(prev => {
                 const currentCharts = prev[currentUser.email] || [];
                 const updatedCharts = [newChart, ...currentCharts];
                 return { ...prev, [currentUser.email]: updatedCharts };
            });

            setEditingChart(newChart);
            setCurrentScreen('editor');
            setIsChartDirty(false); 
            setGroupingMethod('random');
        }
    };
    
    const handleLoadChart = async (chartOrId: string | Chart, isReadOnly: boolean = false) => {
        if (!currentUser) {
            toast.error("יש להתחבר כדי לצפות במפה");
            return;
        }
        
        setIsLoading(true);
        let chartToLoad: Chart | undefined;
        
        if (typeof chartOrId === 'string') {
            console.log("[LoadChart] Attempting to load chart by ID:", chartOrId, "ReadOnly:", isReadOnly);
            // Try to find in user's charts
            chartToLoad = allCharts[currentUser.email]?.find(c => c.id === chartOrId);
            
            // If not found, fetch from Firestore
            if (!chartToLoad) {
                console.log("[LoadChart] Chart not found in local state, fetching from Firestore...");
                try {
                    const fetchedChart = await loadChartById(chartOrId);
                    if (fetchedChart) {
                        console.log("[LoadChart] Chart fetched successfully from Firestore");
                        chartToLoad = fetchedChart;
                    } else {
                        console.warn("[LoadChart] Chart not found in Firestore or Permission Denied");
                        toast.error("המפה לא נמצאה או שאין לך הרשאות לצפות בה");
                    }
                } catch (err) {
                    console.error("[LoadChart] Error fetching chart:", err);
                    toast.error("שגיאה בטעינת המפה. אנא נסה שוב.");
                }
            }
        } else {
            chartToLoad = chartOrId;
        }

        if (chartToLoad) {
            console.log("[LoadChart] Loading chart:", chartToLoad.className);
            // Log activity
            if (auth.currentUser && userProfile) {
                const activity = {
                    timestamp: new Date().toISOString(),
                    action: "צפייה במפה",
                    details: chartToLoad.className
                };
                const updatedLog = [...(userProfile.stats?.activityLog || []), activity].slice(-50);
                updateUserAdminFields(auth.currentUser.uid, {
                    stats: { ...userProfile.stats!, activityLog: updatedLog }
                }).catch(e => console.warn("Failed to log activity", e));
                setUserProfile({ ...userProfile, stats: { ...userProfile.stats!, activityLog: updatedLog } });
            }

            let migratedChart = JSON.parse(JSON.stringify(chartToLoad));
            migratedChart.isReadOnly = isReadOnly;
            if (migratedChart.layoutType === 'rows') {
                const details = migratedChart.layoutDetails as RowsLayoutDetails;
                if (details.rows && details.cols && !details.columnConfiguration) {
                    details.columnConfiguration = Array(details.cols).fill(details.rows);
                    delete details.rows;
                    delete details.cols;
                }
            }
            const cleanChart = {...migratedChart};

            // Auto-mark notification as read if loading a shared chart
            if (userProfile?.notifications) {
                // The chartId in notification might be a full path or just the ID
                const notification = userProfile.notifications.find(n => 
                    (n.chartId === cleanChart.id || n.chartId?.endsWith(`/${cleanChart.id}`)) && !n.read
                );
                if (notification) {
                    // Call handleReadNotification and wait for it to ensure sync
                    await handleReadNotification(notification.id);
                }
            }

            setEditingChart(cleanChart);
            setCurrentScreen(cleanChart.isReadOnly ? 'result' : (cleanChart.generatedLayout ? 'result' : 'editor'));
            setIsChartDirty(false);
            toast.success(`טוען את המפה: ${cleanChart.className}`);
        }
        
        setIsLoading(false);
    };
    
    const handleDeleteChart = useCallback(async (chartId: string) => {
        if (!currentUser) return;
        const userEmail = currentUser.email;

        try {
            // 1. Delete the chart from Firestore
            await deleteChart(chartId);
            
            // 2. Explicitly clear any notifications related to this chart in Firestore
            // Use local userProfile instead of getDocFromServer to save quota and improve speed
            if (userProfile) {
                const currentNotifications = userProfile.notifications || [];
                const updatedNotifications = currentNotifications.filter((n: any) => 
                    n.chartId !== chartId && !n.chartId?.endsWith(`/${chartId}`)
                );
                
                if (updatedNotifications.length !== currentNotifications.length) {
                    // Optimistically update local state
                    setUserProfile(prev => {
                        if (!prev) return prev;
                        return { ...prev, notifications: updatedNotifications };
                    });
                    
                    const userDocRef = doc(db, "users", currentUser.uid);
                    await updateDoc(userDocRef, {
                        notifications: updatedNotifications
                    });
                }
            }
            
            // 3. Update local state and ref
            setAllCharts(prevAllCharts => {
                const currentCharts = prevAllCharts[userEmail] || [];
                const updatedCharts = currentCharts.filter(c => c.id !== chartId);
                
                // Update ref to prevent auto-save from thinking there's a new change to save
                lastSavedChartsRef.current = JSON.stringify(updatedCharts);
                
                return {
                    ...prevAllCharts,
                    [userEmail]: updatedCharts
                };
            });

            // 4. If we are currently editing this chart, go back to main screen
            if (editingChart?.id === chartId) {
                setEditingChart(null);
                setCurrentScreen('main');
            }
            
            const chartType = editingChart?.layoutType === 'groups' ? 'הקבוצה' : 'המפה';
            toast.success(`${chartType} וההתראות הקשורות אליה נמחקו לצמיתות`);
        } catch (err: any) {
            console.error("Failed to delete chart or notifications:", err);
            if (err instanceof FirestoreQuotaError) {
                setQuotaExceeded(true);
                toast.error("מכסת השימוש בבסיס הנתונים הסתיימה להיום. המחיקה נכשלה.");
            } else {
                // Try to extract a more user-friendly message if it's a JSON error from handleFirestoreError
                let displayMsg = "שגיאה במחיקה מהשרת. נסה שוב מאוחר יותר.";
                try {
                    const errData = JSON.parse(err.message);
                    if (errData.error) {
                        if (errData.error.includes("insufficient permissions")) {
                            displayMsg = "אין לך הרשאות למחוק מפה זו.";
                        } else {
                            displayMsg = `שגיאה מהשרת: ${errData.error}`;
                        }
                    }
                } catch (e) {
                    // Not a JSON error, use the raw message if it's short
                    if (err.message && err.message.length < 100) {
                        displayMsg = `שגיאה: ${err.message}`;
                    }
                }
                toast.error(displayMsg);
            }
        }
    }, [currentUser, userProfile, editingChart]);

    const handleDuplicateChart = useCallback(async (chartOrId: string | Chart, keepConstraints: boolean) => {
        if (!currentUser) return;
        const userEmail = currentUser.email;
        
        let originalChart: Chart | undefined;
        
        if (typeof chartOrId === 'string') {
            const charts = allCharts[userEmail] || [];
            originalChart = charts.find(c => c.id === chartOrId);
        } else {
            originalChart = chartOrId;
        }

        if (!originalChart) return;

        // Auto-mark notification as read if duplicating a shared chart
        if (userProfile?.notifications) {
            const notification = userProfile.notifications.find(n => 
                (n.chartId === originalChart?.id || n.chartId?.endsWith(`/${originalChart?.id}`)) && !n.read
            );
            if (notification) {
                await handleReadNotification(notification.id);
            }
        }

        const newChart = JSON.parse(JSON.stringify(originalChart)) as Chart;
        newChart.id = generateId();
        newChart.className = originalChart.className;
        const baseName = originalChart.name || new Date(originalChart.creationDate).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' ');
        newChart.name = `${baseName} (עותק)`;
        newChart.creationDate = new Date().toISOString();
        newChart.generatedLayout = null;
        newChart.ownerId = auth.currentUser?.uid || '';
        newChart.ownerName = userProfile ? `${userProfile.firstName} ${userProfile.lastName}` : (currentUser.name || 'מורה');
        newChart.ownerSchool = userProfile?.schoolName || '';
        newChart.sharedWith = [];
        newChart.sharedWithEmails = [];
        newChart.isCopy = true;
        
        if (!keepConstraints) {
            newChart.constraints = [];
            newChart.students = newChart.students.map(student => {
                const newStudent: Student = {
                    id: student.id,
                    name: student.name,
                    picture: student.picture || '',
                    gender: student.gender || '',
                    ratings: {},
                    constraints: { ...DEFAULT_STUDENT_CONSTRAINTS },
                    academicLevel: 0, 
                    behaviorLevel: 0, 
                };
                return newStudent;
            });
        }

        setAllCharts(prev => {
            const charts = prev[userEmail] || [];
            const updatedCharts = [newChart, ...charts];
            return {
                ...prev,
                [userEmail]: updatedCharts
            };
        });

        setEditingChart(newChart);
        setCurrentScreen('editor');
        setIsChartDirty(true);
        toast.success(`${newChart.layoutType === 'groups' ? 'הקבוצה' : 'המפה'} שוכפלה בהצלחה!`);
    }, [currentUser, allCharts, userProfile]);
    
    const handleDeleteClass = useCallback(async (className: string) => {
        if (!currentUser || !auth.currentUser) {
            toast.error("עליך להיות מחובר כדי למחוק כיתה");
            return;
        }
        
        const userEmail = currentUser.email;
        const myCharts = allCharts[userEmail] || [];
        
        // Only delete charts that I actually own to avoid permission errors
        const chartsToDelete = myCharts.filter(c => 
            c.className === className && (c.ownerId === currentUser.uid || c.ownerId === auth.currentUser?.uid)
        );
        const chartIdsToDelete = chartsToDelete.map(c => c.id);

        console.log(`[DeleteClass] Class: ${className}, Charts found: ${chartsToDelete.length}`, chartIdsToDelete);

        if (chartIdsToDelete.length === 0) {
            toast.error(`לא נמצאו מערכים השייכים לך בכיתה "${className}"`);
            return;
        }

        try {
            // 1. Delete all charts of this class from Firestore in batch
            await deleteChartsBatch(chartIdsToDelete);
            
            // 2. Clear notifications for all deleted charts
            if (userProfile) {
                const currentNotifications = userProfile.notifications || [];
                const updatedNotifications = currentNotifications.filter((n: any) => 
                    !chartIdsToDelete.some(id => n.chartId === id || n.chartId?.endsWith(`/${id}`))
                );
                
                if (updatedNotifications.length !== currentNotifications.length) {
                    // Optimistically update local state
                    setUserProfile(prev => {
                        if (!prev) return prev;
                        return { ...prev, notifications: updatedNotifications };
                    });
                    
                    const userDocRef = doc(db, "users", currentUser.uid);
                    await updateDoc(userDocRef, {
                        notifications: updatedNotifications
                    });
                }
            }
            
            // 3. Update local state and ref
            setAllCharts(prevAllCharts => {
                const currentCharts = prevAllCharts[userEmail] || [];
                const updatedCharts = currentCharts.filter(c => c.className !== className);
                
                // Update ref to prevent auto-save
                lastSavedChartsRef.current = JSON.stringify(updatedCharts);
                
                return {
                    ...prevAllCharts,
                    [userEmail]: updatedCharts
                };
            });
            
            toast.success(`הכיתה "${className}" וכל המערכים שלה נמחקו לצמיתות`);
        } catch (err: any) {
            console.error("Failed to delete class:", err);
            if (err instanceof FirestoreQuotaError) {
                setQuotaExceeded(true);
                toast.error("מכסת השימוש בבסיס הנתונים הסתיימה להיום. המחיקה נכשלה.");
            } else {
                let displayMsg = "שגיאה במחיקת הכיתה מהשרת. נסה שוב מאוחר יותר.";
                try {
                    // handleFirestoreError throws Error(JSON.stringify(errInfo))
                    const errData = JSON.parse(err.message);
                    if (errData.error) {
                        if (errData.error.toLowerCase().includes("permission")) {
                            displayMsg = "אין לך הרשאות למחוק חלק מהמערכים בכיתה זו.";
                        } else {
                            displayMsg = `שגיאה מהשרת: ${errData.error}`;
                        }
                    }
                } catch (e) {
                    // If not JSON, show the raw error if it's short
                    if (err.message && err.message.length < 150) {
                        displayMsg = `שגיאה: ${err.message}`;
                    }
                }
                toast.error(displayMsg);
            }
        }
    }, [currentUser, allCharts, userProfile]);

    const handleUpdateClassName = useCallback(async (oldClassName: string, newClassName: string): Promise<boolean> => {
        if (!currentUser) return false;
        const userEmail = currentUser.email;
        const trimmedNewName = newClassName.trim();
        if (!trimmedNewName) {
            toast.error('שם הכיתה לא יכול להיות ריק.');
            return false;
        }

        let success = true;

        setAllCharts(prevAllCharts => {
            const userCharts = prevAllCharts[userEmail] || [];
            const existingClassNames = Array.from(new Set(userCharts.map(c => c.className)));
            if (existingClassNames.some((cn: string) => cn.toLowerCase() === trimmedNewName.toLowerCase() && cn.toLowerCase() !== oldClassName.toLowerCase())) {
                toast.error('כיתה בשם זה כבר קיימת.');
                success = false;
                return prevAllCharts;
            }

            const updatedCharts = userCharts.map(chart => {
                if (chart.className === oldClassName) {
                    return { ...chart, className: trimmedNewName };
                }
                return chart;
            });
            
            return { ...prevAllCharts, [userEmail]: updatedCharts };
        });
        
        return success;
    }, [currentUser]);

    const handleUpdateChartName = useCallback(async (chartId: string, newName: string): Promise<boolean> => {
        if (!currentUser) return false;
        const userEmail = currentUser.email;
        
        setAllCharts(prevAllCharts => {
            const userCharts = prevAllCharts[userEmail] || [];
            const updatedCharts = userCharts.map(chart => {
                if (chart.id === chartId) {
                    return { ...chart, name: newName.trim() };
                }
                return chart;
            });
            
            return { ...prevAllCharts, [userEmail]: updatedCharts };
        });
        
        return true;
    }, [currentUser]);

    const handleImportCharts = useCallback(async (newCharts: Chart[]) => {
        if (!currentUser || !auth.currentUser || newCharts.length === 0) return;
        
        const userEmail = currentUser.email;
        const currentUid = auth.currentUser.uid;
        
        // Force the ownerId to be the current user's UID to ensure they show up in the user's list
        // especially if importing from a different environment or a remixed app.
        const chartsWithNewOwner = newCharts.map(chart => ({
            ...chart,
            ownerId: currentUid,
            ownerName: userProfile ? `${userProfile.firstName} ${userProfile.lastName}` : (currentUser.name || chart.ownerName),
            ownerSchool: userProfile?.schoolName || chart.ownerSchool,
            // Ensure shared fields are cleared to avoid permission issues
            sharedWith: [],
            sharedWithEmails: []
        }));
        
        try {
            // 1. Persist to Firestore immediately
            await saveUserCharts(currentUid, chartsWithNewOwner);
            
            // 2. Update local state
            setAllCharts(prevAllCharts => {
                const currentCharts = prevAllCharts[userEmail] || [];
                
                // Filter out any charts that might have already been added by the onSnapshot listener
                // to prevent duplicates during the race condition between local update and cloud sync.
                const existingIds = new Set(currentCharts.map(c => c.id));
                const uniqueNewCharts = chartsWithNewOwner.filter(c => !existingIds.has(c.id));
                
                if (uniqueNewCharts.length === 0) return prevAllCharts;
                
                const updatedCharts = [...currentCharts, ...uniqueNewCharts];
                
                // Update ref to prevent auto-save from firing
                lastSavedChartsRef.current = JSON.stringify(updatedCharts);
                
                return {
                    ...prevAllCharts,
                    [userEmail]: updatedCharts
                };
            });
            
            toast.success(`יובאו בהצלחה ${newCharts.length} מפות חדשות!`);
        } catch (err) {
            console.error("Failed to import charts:", err);
            toast.error("שגיאה בייבוא המפות לשרת");
        }
    }, [currentUser, userProfile]);

    const handleReorderCharts = useCallback(async (updatedCharts: Chart[]) => {
        if (!currentUser || !auth.currentUser) return;
        
        const userEmail = currentUser.email;
        
        // Update local state optimistically
        setAllCharts(prevAllCharts => {
            const currentCharts = prevAllCharts[userEmail] || [];
            const updatedMap = new Map(updatedCharts.map(c => [c.id, c]));
            const newCharts = currentCharts.map(c => updatedMap.get(c.id) || c);
            
            lastSavedChartsRef.current = JSON.stringify(newCharts);
            
            return {
                ...prevAllCharts,
                [userEmail]: newCharts
            };
        });

        // Persist to Firestore
        try {
            await saveUserCharts(auth.currentUser.uid, updatedCharts);
        } catch (err) {
            console.error("Failed to save reordered charts:", err);
            toast.error("שגיאה בשמירת סדר המפות");
        }
    }, [currentUser]);


    const handleGenerateChart = async (chartToGenerate?: Chart, preGeneratedLayout?: GeneratedLayout | null) => {
        const chart = chartToGenerate || editingChart;
        if (!chart || !currentUser) return;
        
        if (chartToGenerate) {
            handleSetEditingChart(chartToGenerate); 
        }

        setIsLoading(true);

        await new Promise(resolve => setTimeout(resolve, 50)); 

        try {
            const result = preGeneratedLayout || generateLayout(chart, groupingMethod);

            const currentHistory = chart.layoutHistory || (chart.generatedLayout ? [chart.generatedLayout] : []);
            const newHistory = [...currentHistory, result];
            const newIndex = newHistory.length - 1;

            const updatedChart = { 
                ...chart, 
                generatedLayout: result,
                layoutHistory: newHistory,
                activeLayoutIndex: newIndex
            };
            
            setEditingChart(updatedChart);
            setIsChartDirty(true); 

            // Credits logic removed
            setCurrentScreen('result');
        } catch (error) {
            console.error("Error in chart generation:", error);
            alert(`אירעה שגיאה בעת יצירת המפה/קבוצות. פרטי השגיאה: ${error instanceof Error ? error.message : String(error)}`);
            setCurrentScreen('editor'); 
        } finally {
            setIsLoading(false);
        }
    };

    const handleChangeVersion = (newIndex: number) => {
        if (!editingChart || !editingChart.layoutHistory) return;

        if (newIndex >= 0 && newIndex < editingChart.layoutHistory.length) {
            handleSetEditingChart(prev => {
                if (!prev || !prev.layoutHistory) return prev;
                return {
                    ...prev,
                    activeLayoutIndex: newIndex,
                    generatedLayout: prev.layoutHistory[newIndex],
                };
            });
        }
    };
    
    const handleConvertLayout = () => {
        if (!editingChart) return;
        const newType = editingChart.layoutType === 'rows' ? 'groups' : 'rows';
        const newLayoutDetails = newType === 'rows' ? { ...DEFAULT_ROWS_LAYOUT } : { ...DEFAULT_GROUPS_LAYOUT };
        
        const convertedChart: Chart = {
            ...editingChart,
            layoutType: newType,
            layoutDetails: newLayoutDetails,
            generatedLayout: null,
        };
        
        handleSetEditingChart(convertedChart);
        setCurrentScreen('editor');
    };

    const handleSpreadStudents = () => {
        if (!editingChart || editingChart.layoutType !== 'rows' || !editingChart.generatedLayout) {
            return;
        }
    
        const chart = JSON.parse(JSON.stringify(editingChart)) as Chart; // Deep copy
        if (!chart.generatedLayout || !('desks' in chart.generatedLayout)) {
            return;
        }
    
        // --- Start: Local helper functions ---
        const allStudentsMap = new Map(chart.students.map(s => [s.name, s]));
        const getStudentById = (id: string) => chart.students.find(s => s.id === id);
    
        const checkDeskPositionConstraints = (student: Student, row: number, col: number): boolean => {
            const constraints = { ...DEFAULT_STUDENT_CONSTRAINTS, ...(student.constraints || {}) };
            const { allowedRows, allowedCols } = constraints;
            if (allowedRows && allowedRows.length > 0 && !allowedRows.includes(row)) return false;
            if (allowedCols && allowedCols.length > 0 && !allowedCols.includes(col)) return false;
            return true;
        };
    
        const canSitTogether = (student1Name: string, student2Name: string): boolean => {
            const student1 = allStudentsMap.get(student1Name);
            const student2 = allStudentsMap.get(student2Name);
            if (!student1 || !student2) return true;
            const student1DontSitWithNames = (student1.constraints.dontSitWith || []).map(id => getStudentById(id)?.name).filter(Boolean) as string[];
            const student2DontSitWithNames = (student2.constraints.dontSitWith || []).map(id => getStudentById(id)?.name).filter(Boolean) as string[];
            return !student1DontSitWithNames.includes(student2Name) && !student2DontSitWithNames.includes(student1Name);
        };
        // --- End: Local helper functions ---
    
        const { desks } = chart.generatedLayout;
        
        // === PHASE 1: Place unplaced students ===
        let studentsToPlace = (chart.generatedLayout.unplacedStudents || [])
            .map(info => allStudentsMap.get(info.name))
            .filter((s): s is Student => !!s);
            
        let stillUnplacedStudents: UnplacedStudentInfo[] = [];
        studentsToPlace.sort(() => Math.random() - 0.5);
    
        for (const student of studentsToPlace) {
            let placed = false;
            
            // Try empty desks first to maximize desk usage
            for (const desk of desks) {
                if (desk.students.length === 0 && checkDeskPositionConstraints(student, desk.row, desk.col)) {
                    desk.students.push({ id: student.id, name: student.name, seat: 1 });
                    placed = true;
                    break;
                }
            }
            
            if (placed) continue;
            
            // Then try desks with 1 student
            for (const desk of desks) {
                if (desk.students.length === 1) {
                    const occupant = allStudentsMap.get(desk.students[0].name);
                    if (occupant && !occupant.constraints.sitAlone && checkDeskPositionConstraints(student, desk.row, desk.col) && canSitTogether(student.name, occupant.name)) {
                        const occupiedSeat = desk.students[0].seat;
                        desk.students.push({ id: student.id, name: student.name, seat: occupiedSeat === 1 ? 2 : 1 });
                        placed = true;
                        break;
                    }
                }
            }
    
            if (!placed) {
                stillUnplacedStudents.push({ id: student.id, name: student.name, reason: "לא נמצא מקום פנוי שעומד בהעדפות במהלך הפריסה." });
            }
        }
    
        chart.generatedLayout.unplacedStudents = stillUnplacedStudents;
    
        // === PHASE 2: Spread existing pairs into remaining empty desks ===
        let pairedDesks = desks.filter(d => d.students.length === 2);
        let emptyDesks = desks.filter(d => d.students.length === 0);

        pairedDesks.sort(() => Math.random() - 0.5);
    
        while (pairedDesks.length > 0 && emptyDesks.length > 0) {
            const sourceDesk = pairedDesks.shift()!;
    
            for (let i = sourceDesk.students.length - 1; i >= 0; i--) {
                const studentInfo = sourceDesk.students[i];
                const student = allStudentsMap.get(studentInfo.name);
                if (!student) continue;
    
                const partnerInfo = sourceDesk.students[i === 0 ? 1 : 0];
                const partner = allStudentsMap.get(partnerInfo.name);
                if (partner && (student.constraints.sitWith || []).includes(partner.id)) {
                    continue; 
                }
    
                let targetDeskIndex = -1;
                for (let j = 0; j < emptyDesks.length; j++) {
                    if (checkDeskPositionConstraints(student, emptyDesks[j].row, emptyDesks[j].col)) {
                        targetDeskIndex = j;
                        break;
                    }
                }
    
                if (targetDeskIndex !== -1) {
                    const targetDesk = emptyDesks.splice(targetDeskIndex, 1)[0];
                    sourceDesk.students.splice(i, 1);
                    targetDesk.students.push({ id: student.id, name: student.name, seat: 1 });
                    break; 
                }
            }
        }
        
        handleSetEditingChart(chart);
        setIsChartDirty(true);
    };

    const handleClearPins = () => {
        if (!editingChart) return;
        if (window.confirm("האם לבטל את כל הנעיצות (המיקומים הקבועים) של התלמידים?")) {
            const newChart = JSON.parse(JSON.stringify(editingChart)) as Chart;
            newChart.students.forEach((s: Student) => {
                s.constraints = {
                    ...s.constraints,
                    allowedRows: null,
                    allowedCols: null,
                    allowedSeats: null
                };
            });
            handleSetEditingChart(newChart);
            setIsChartDirty(true);
            toast.success("כל הנעיצות בוטלו בהצלחה");
        }
    };
    
    const handleReadNotification = async (notificationId: string) => {
        if (!auth.currentUser) return;
        
        console.log("Marking notification as read:", notificationId);
        
        // Optimistically update local state for immediate feedback
        setUserProfile(prev => {
            if (!prev || !prev.notifications) return prev;
            return {
                ...prev,
                notifications: prev.notifications.map(n => 
                    n.id === notificationId ? { ...n, read: true } : n
                )
            };
        });
        
        try {
            const userDocRef = doc(db, "users", auth.currentUser.uid);
            const userDoc = await getDocFromServer(userDocRef);
            if (userDoc.exists()) {
                const currentNotifications = userDoc.data().notifications || [];
                const updatedNotifications = currentNotifications.map((n: any) => 
                    n.id === notificationId ? { ...n, read: true } : n
                );
                
                await updateDoc(userDocRef, {
                    notifications: updatedNotifications
                });
                console.log("Notification updated in Firestore");
            }
        } catch (err) {
            console.error("Error updating notification:", err);
            // Rollback local state if Firestore update fails
            const profileData = await loadUserProfile(auth.currentUser.uid);
            if (profileData) setUserProfile(profileData);
        }
    };

    const handleDeleteNotification = async (notificationId: string) => {
        if (!auth.currentUser) return;
        
        try {
            const userDocRef = doc(db, "users", auth.currentUser.uid);
            const userDoc = await getDocFromServer(userDocRef);
            if (userDoc.exists()) {
                const currentNotifications = userDoc.data().notifications || [];
                const updatedNotifications = currentNotifications.filter((n: any) => n.id !== notificationId);
                
                await updateDoc(userDocRef, {
                    notifications: updatedNotifications
                });
            }
        } catch (err) {
            console.error("Error deleting notification:", err);
        }
    };

    const handleClearAllNotifications = async () => {
        if (!auth.currentUser) return;
        
        try {
            await updateDoc(doc(db, "users", auth.currentUser.uid), {
                notifications: []
            });
            toast.success("כל ההתראות נמחקו");
        } catch (err) {
            console.error("Error clearing all notifications:", err);
            toast.error("שגיאה במחיקת ההתראות");
        }
    };

    const handleNotificationAction = async (notification: AppNotification) => {
        console.log("[NotificationAction] Triggered for:", notification.id, "Type:", notification.type);
        if (notification.type === 'share' && notification.chartId) {
            if (!notification.read) {
                await handleReadNotification(notification.id);
            }
            await handleLoadChart(notification.chartId);
        } else {
            console.warn("[NotificationAction] Unsupported notification type or missing chartId:", notification);
        }
    };

    const handleDuplicateNotificationAction = async (notification: AppNotification) => {
        if (notification.type === 'share' && notification.chartId) {
            try {
                if (!notification.read) {
                    await handleReadNotification(notification.id);
                }
                
                const userEmail = currentUser?.email || '';
                const charts = allCharts[userEmail] || [];
                let chartToDuplicate: Chart | null | undefined = charts.find(c => c.id === notification.chartId);
                
                if (!chartToDuplicate) {
                    toast.loading("טוען מפה לשכפול...", { id: 'loading-duplicate' });
                    chartToDuplicate = await loadChartById(notification.chartId);
                    toast.dismiss('loading-duplicate');
                }
                
                if (chartToDuplicate) {
                    await handleDuplicateChart(chartToDuplicate, true);
                    toast.success("העותק נוצר בהצלחה ונשמר ברשימת המפות שלך");
                } else {
                    toast.error("לא ניתן היה למצוא את המפה לשכפול");
                }
            } catch (error) {
                console.error("Error duplicating from notification:", error);
                toast.error("שגיאה ביצירת עותק");
            }
        }
    };

    const handleOnboardingComplete = (profile: UserProfile) => {
        setUserProfile(profile);
        if (auth.currentUser) {
            setCurrentUser({
                uid: auth.currentUser.uid,
                email: profile.email,
                name: `${profile.firstName} ${profile.lastName}`,
                picture: auth.currentUser.photoURL || null,
                role: profile.role,
                isFrozen: profile.isFrozen
            });
        }
        setShowOnboarding(false);
        
        // If super admin, go to admin panel automatically
        if (profile.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
            setCurrentScreen('admin');
        } else {
            setCurrentScreen('main');
        }

        // Track login after onboarding
        if (auth.currentUser) {
            trackLogin(auth.currentUser.uid);
        }
    };

    const renderContent = () => {
        if (currentScreen === 'login') {
            return <LoginScreen onLogin={() => {}} />;
        }

        if (isLoading) {
             return (
                <div className="flex flex-col items-center justify-center h-full">
                    <div className="animate-spin-fast rounded-full h-16 w-16 border-b-4 border-teal-500 mx-auto"></div>
                    <h2 className="text-2xl font-bold text-slate-700 mt-6">טוען נתונים מהענן...</h2>
                </div>
            );
        }
        
        if (currentUser?.isFrozen && currentUser.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        return (
            <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 text-center">
                <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border-t-4 border-red-500">
                    <div className="bg-red-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
                        <AlertTriangle className="h-8 w-8 text-red-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-800 mb-4">חשבונך הוקפא</h2>
                    <p className="text-slate-600 mb-8 leading-relaxed">
                        הגישה לאפליקציה הופסקה זמנית על ידי מנהל המערכת. 
                        אנא צור קשר עם לירן לפרטים נוספים.
                    </p>
                    <button 
                        onClick={handleLogout}
                        className="w-full bg-slate-800 text-white py-3 rounded-xl font-bold hover:bg-slate-700 transition-all"
                    >
                        התנתק
                    </button>
                </div>
            </div>
        );
    }

    switch (currentScreen) {
            case 'main':
                return currentUser && <MainScreen
                    user={currentUser}
                    profile={userProfile}
                    allCharts={allCharts[currentUser.email] || []}
                    onStartNew={handleStartNewChart}
                    onLoadChart={handleLoadChart}
                    onDeleteChart={handleDeleteChart}
                    onDuplicateChart={handleDuplicateChart}
                    onDeleteClass={handleDeleteClass}
                    onUpdateClassName={handleUpdateClassName}
                    onUpdateChartName={handleUpdateChartName}
                    onImportCharts={handleImportCharts}
                    onReorderCharts={handleReorderCharts}
                    isCloudSync={!!auth}
                />;
            case 'editor':
                return editingChart && <EditorScreen 
                    chart={editingChart}
                    setChart={handleSetEditingChart}
                    onGenerate={handleGenerateChart}
                    groupingMethod={groupingMethod}
                    setGroupingMethod={setGroupingMethod}
                    currentUserId={auth.currentUser?.uid}
                />;
            case 'result':
                return editingChart && <ResultScreen 
                    chart={editingChart}
                    onRegenerate={handleGenerateChart}
                    onGoToEditor={() => setCurrentScreen('editor')}
                    onUpdateChart={(updatedChart) => handleSetEditingChart(updatedChart)}
                    onClearPins={handleClearPins}
                                      
                    isAdmin={currentUser?.role === 'admin' || currentUser?.email === ADMIN_EMAIL}
    
                />;
            case 'admin':
                return currentUser ? <AdminPanel user={currentUser} onBack={() => setCurrentScreen('main')} onLoadChart={handleLoadChart} /> : null;
            default:
                return null; 
        }
    };

    if (isLoading && !currentUser) {
       return (
           <div className="min-h-screen flex items-center justify-center bg-slate-100">
               <div className="animate-spin-fast rounded-full h-16 w-16 border-b-4 border-teal-500 mx-auto"></div>
           </div>
       );
   }

    if (currentScreen === 'login' && !currentUser) {
        return <div className="min-h-screen flex items-center justify-center bg-slate-100">{renderContent()}</div>;
    }
    
    if (!currentUser) return null;

    const isEditorOrResult = ['editor', 'result'].includes(currentScreen);

    return (
        <div className="min-h-screen flex flex-col bg-slate-100 overflow-hidden" dir="rtl">
            <Toaster position="top-center" richColors />
            
            {showBackConfirm && (
                <ConfirmActionModal
                    title="יציאה ללא שמירה"
                    message="יש שינויים שלא נשמרו. האם לצאת בכל זאת?"
                    confirmText="כן, צא ללא שמירה"
                    cancelText="ביטול"
                    onConfirm={() => {
                        setEditingChart(null);
                        setCurrentScreen('main');
                        setShowBackConfirm(false);
                    }}
                    onCancel={() => setShowBackConfirm(false)}
                    danger={true}
                />
            )}
            
            {quotaExceeded && (
                <div className="bg-amber-50 border-b border-amber-200 p-2 flex items-center justify-center gap-2 text-amber-800 text-sm font-medium">
                    <AlertTriangle size={16} />
                    <span>מכסת השימוש היומית בבסיס הנתונים הסתיימה. השינויים נשמרים מקומית בדפדפן שלך.</span>
                </div>
            )}

             {isEditorOrResult && editingChart ? (
                <EditorHeader
                    chart={editingChart}
                    currentScreen={currentScreen}
                    onSaveAndExit={handleSaveAndExit}
                    onBackToMain={handleBackToMain}
                    onGoToEditor={() => setCurrentScreen('editor')}
                    onUpdateChart={handleSetEditingChart}
                    onRegenerate={() => handleGenerateChart(editingChart)}
                    onConvertLayout={handleConvertLayout}
                    onSpreadStudents={handleSpreadStudents}
                    onDeleteChart={handleDeleteChart}
                    onClearPins={handleClearPins}
                    onChangeVersion={handleChangeVersion}
                />
             ) : (
                <MainHeader 
                    user={currentUser} 
                    profile={userProfile}
                    onLogout={handleLogout} 
                    onGoToAdmin={() => setCurrentScreen('admin')} 
                    onReadNotification={handleReadNotification}
                    onDeleteNotification={handleDeleteNotification}
                    onClearAllNotifications={handleClearAllNotifications}
                    onActionNotification={handleNotificationAction}
                />
             )}
            <main className="flex-grow flex flex-col overflow-hidden relative">
                {renderContent()}
                {showOnboarding && auth.currentUser && (
                    <OnboardingModal 
                        email={auth.currentUser.email || ''}
                        uid={auth.currentUser.uid} 
                        onComplete={handleOnboardingComplete} 
                        onLogout={handleLogout}
                    />
                )}
            </main>
        </div>
    );
};

export default App;
