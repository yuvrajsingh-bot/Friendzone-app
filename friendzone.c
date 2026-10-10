#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_STUDENTS 100
#define MAX_FRIENDSHIPS 300
#define NAME_LENGTH 50
#define DEPARTMENT_LENGTH 40
#define CITY_LENGTH 40
#define DATA_FILE "friendzone_data.txt"

typedef struct {
    int id;
    char name[NAME_LENGTH];
    char department[DEPARTMENT_LENGTH];
    int year;
    char city[CITY_LENGTH];
} Student;

typedef struct {
    int firstStudentId;
    int secondStudentId;
} Friendship;

static Student students[MAX_STUDENTS];
static Friendship friendships[MAX_FRIENDSHIPS];
static int studentCount;
static int friendshipCount;

static void readLine(const char *prompt, char *buffer, size_t size)
{
    size_t length;

    printf("%s", prompt);
    if (fgets(buffer, (int)size, stdin) == NULL) {
        buffer[0] = '\0';
        return;
    }

    length = strlen(buffer);
    if (length > 0 && buffer[length - 1] == '\n') {
        buffer[length - 1] = '\0';
    } else {
        int character;
        while ((character = getchar()) != '\n' && character != EOF) {
            /* Discard input that did not fit in the buffer. */
        }
    }
}

static int readInteger(const char *prompt)
{
    char line[32];
    char extra;
    int value;

    for (;;) {
        readLine(prompt, line, sizeof(line));
        if (sscanf(line, " %d %c", &value, &extra) == 1) {
            return value;
        }
        printf("Please enter a whole number.\n");
    }
}

static int findStudentIndex(int id)
{
    int index;

    for (index = 0; index < studentCount; index++) {
        if (students[index].id == id) {
            return index;
        }
    }
    return -1;
}

static void saveData(void)
{
    FILE *file = fopen(DATA_FILE, "w");
    int index;

    if (file == NULL) {
        perror("Could not save community data");
        return;
    }

    fprintf(file, "%d\n", studentCount);
    for (index = 0; index < studentCount; index++) {
        fprintf(file, "%d|%s|%s|%d|%s\n",
                students[index].id, students[index].name,
                students[index].department, students[index].year,
                students[index].city);
    }
    fprintf(file, "%d\n", friendshipCount);
    for (index = 0; index < friendshipCount; index++) {
        fprintf(file, "%d %d\n", friendships[index].firstStudentId,
                friendships[index].secondStudentId);
    }
    if (fclose(file) != 0) {
        perror("Could not finish saving community data");
        return;
    }
    printf("Community data saved to %s.\n", DATA_FILE);
}

static void loadData(void)
{
    FILE *file = fopen(DATA_FILE, "r");
    char line[NAME_LENGTH + DEPARTMENT_LENGTH + CITY_LENGTH + 40];
    int count;
    int index;

    if (file == NULL) {
        return;
    }

    if (fscanf(file, "%d\n", &count) != 1 || count < 0 || count > MAX_STUDENTS) {
        fprintf(stderr, "Data file has an invalid student count; starting empty.\n");
        fclose(file);
        return;
    }

    for (index = 0; index < count; index++) {
        int fields;

        students[index].city[0] = '\0';
        if (fgets(line, sizeof(line), file) == NULL) {
            fprintf(stderr, "Data file has an invalid student record; starting empty.\n");
            fclose(file);
            studentCount = 0;
            friendshipCount = 0;
            return;
        }
        fields = sscanf(line, "%d|%49[^|]|%39[^|]|%d|%39[^\n]",
                        &students[index].id, students[index].name,
                        students[index].department, &students[index].year,
                        students[index].city);
        if (fields < 4 || strchr(line, '|') == NULL) {
            fprintf(stderr, "Data file has an invalid student record; starting empty.\n");
            fclose(file);
            studentCount = 0;
            friendshipCount = 0;
            return;
        }
    }
    studentCount = count;

    if (fscanf(file, "%d\n", &count) != 1 || count < 0 || count > MAX_FRIENDSHIPS) {
        fprintf(stderr, "Data file has an invalid friendship count; keeping students only.\n");
        fclose(file);
        return;
    }
    for (index = 0; index < count; index++) {
        if (fscanf(file, "%d %d\n", &friendships[index].firstStudentId,
                   &friendships[index].secondStudentId) != 2) {
            fprintf(stderr, "Data file has an invalid friendship record; keeping students only.\n");
            friendshipCount = 0;
            fclose(file);
            return;
        }
    }
    friendshipCount = count;
    fclose(file);
}

static void addStudent(void)
{
    Student student;

    if (studentCount == MAX_STUDENTS) {
        printf("The student list is full.\n");
        return;
    }

    student.id = readInteger("Student ID: ");
    if (student.id <= 0 || findStudentIndex(student.id) != -1) {
        printf("Use a positive student ID that has not been used before.\n");
        return;
    }

    readLine("Full name: ", student.name, sizeof(student.name));
    readLine("Department: ", student.department, sizeof(student.department));
    student.year = readInteger("Year of study (1-4): ");
    readLine("Hometown: ", student.city, sizeof(student.city));

    if (student.name[0] == '\0' || student.department[0] == '\0' ||
        student.year < 1 || student.year > 4 ||
        strchr(student.name, '|') != NULL ||
        strchr(student.department, '|') != NULL ||
        strchr(student.city, '|') != NULL) {
        printf("Enter a name and department, a year from 1 to 4, and do not use | in a field.\n");
        return;
    }
    students[studentCount++] = student;
    printf("%s has joined FriendZone!\n", student.name);
    saveData();
}

static void listStudents(void)
{
    int index;

    if (studentCount == 0) {
        printf("No students yet. Add someone to get started.\n");
        return;
    }
    printf("\n%-6s %-24s %-24s %-8s %s\n", "ID", "NAME", "DEPARTMENT", "YEAR", "HOMETOWN");
    printf("----------------------------------------------------------------------------\n");
    for (index = 0; index < studentCount; index++) {
        printf("%-6d %-24.24s %-24.24s %-8d %s\n",
               students[index].id, students[index].name,
               students[index].department, students[index].year,
               students[index].city);
    }
}

static void searchStudent(void)
{
    int id = readInteger("Enter the student ID to search: ");
    int index = findStudentIndex(id);

    if (index == -1) {
        printf("No student found with ID %d.\n", id);
        return;
    }
    printf("\nID: %d\nName: %s\nDepartment: %s\nYear: %d\nHometown: %s\n",
           students[index].id, students[index].name,
           students[index].department, students[index].year,
           students[index].city);
}

static void addFriendship(void)
{
    int firstId = readInteger("First student ID: ");
    int secondId = readInteger("Second student ID: ");
    int index;

    if (firstId == secondId) {
        printf("A student cannot be friends with themselves.\n");
        return;
    }
    if (findStudentIndex(firstId) == -1 || findStudentIndex(secondId) == -1) {
        printf("Both IDs must belong to students in FriendZone.\n");
        return;
    }
    for (index = 0; index < friendshipCount; index++) {
        if ((friendships[index].firstStudentId == firstId &&
             friendships[index].secondStudentId == secondId) ||
            (friendships[index].firstStudentId == secondId &&
             friendships[index].secondStudentId == firstId)) {
            printf("These students are already friends.\n");
            return;
        }
    }
    if (friendshipCount == MAX_FRIENDSHIPS) {
        printf("The friendship list is full.\n");
        return;
    }
    friendships[friendshipCount].firstStudentId = firstId;
    friendships[friendshipCount].secondStudentId = secondId;
    friendshipCount++;
    saveData();
    printf("A new friendship has been made!\n");
}

static void viewFriends(void)
{
    int studentId = readInteger("Enter a student ID: ");
    int studentIndex = findStudentIndex(studentId);
    int found = 0;
    int index;

    if (studentIndex == -1) {
        printf("Student not found.\n");
        return;
    }
    printf("\nFriends of %s:\n", students[studentIndex].name);
    for (index = 0; index < friendshipCount; index++) {
        int friendId = -1;
        int friendIndex;

        if (friendships[index].firstStudentId == studentId) {
            friendId = friendships[index].secondStudentId;
        } else if (friendships[index].secondStudentId == studentId) {
            friendId = friendships[index].firstStudentId;
        }
        friendIndex = findStudentIndex(friendId);
        if (friendIndex != -1) {
            printf("- %s (ID %d)\n", students[friendIndex].name, friendId);
            found = 1;
        }
    }
    if (!found) {
        printf("No friends added yet. Start with a hello!\n");
    }
}

static void showMenu(void)
{
    printf("\n========================================\n");
    printf("       FRIENDZONE - CAMPUS CONNECT\n");
    printf("========================================\n");
    printf("1. Add a student\n");
    printf("2. View all students\n");
    printf("3. Search student by ID\n");
    printf("4. Make a friendship\n");
    printf("5. View a student's friends\n");
    printf("6. Save community data\n");
    printf("0. Exit\n");
}

int main(void)
{
    int choice;

    loadData();
    printf("Welcome to FriendZone! %d students loaded.\n", studentCount);
    do {
        showMenu();
        choice = readInteger("Choose an option: ");
        switch (choice) {
            case 1: addStudent(); break;
            case 2: listStudents(); break;
            case 3: searchStudent(); break;
            case 4: addFriendship(); break;
            case 5: viewFriends(); break;
            case 6: saveData(); break;
            case 0: printf("Thanks for bringing your campus closer. Bye!\n"); break;
            default: printf("Choose one of the options shown in the menu.\n"); break;
        }
    } while (choice != 0);
    return 0;
}
